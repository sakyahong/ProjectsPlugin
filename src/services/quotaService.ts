import * as http from 'http';

export interface QuotaInfo {
    modelName: string;
    remaining: number;  // percentage remaining (0-100)
    limit: number;
    resetDate: string;
}

export interface GroupedQuota {
    groupName: string;
    groupId: string;
    remaining: number;  // percentage remaining (0-100)
    limit: number;
    resetDate: string;
    models: QuotaInfo[];
}

export class QuotaService {
    private lastQuota: any = null;
    private lastFetchTime: number = 0;

    constructor() { }

    async getUserStatus(port: number, csrfToken: string, retries = 3): Promise<any> {
        return new Promise((resolve, reject) => {
            const attempt = (remaining: number) => {
                const data = JSON.stringify({
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        ideVersion: '1.0.0',
                        locale: 'en'
                    }
                });

                const options = {
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        'X-Codeium-Csrf-Token': csrfToken,
                        'Connect-Protocol-Version': '1'
                    },
                    timeout: 5000 // 5 seconds timeout
                };

                const req = http.request(options, res => {
                    let responseData = '';
                    res.on('data', chunk => { responseData += chunk; });
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            try {
                                const parsed = JSON.parse(responseData);
                                // Cache success response
                                this.lastQuota = parsed;
                                this.lastFetchTime = Date.now();
                                resolve(parsed);
                            } catch (e) {
                                if (remaining > 0) {
                                    setTimeout(() => attempt(remaining - 1), 1000);
                                } else if (this.lastQuota) {
                                    // Fallback to cache
                                    console.warn('Quota parsing failed, returning cached data');
                                    resolve(this.lastQuota);
                                } else {
                                    reject(new Error('Failed to parse response'));
                                }
                            }
                        } else {
                            if (remaining > 0) {
                                setTimeout(() => attempt(remaining - 1), 1000);
                            } else if (this.lastQuota) {
                                console.warn(`Quota API failed (${res.statusCode}), returning cached data`);
                                resolve(this.lastQuota);
                            } else {
                                reject(new Error(`API failed with status ${res.statusCode}`));
                            }
                        }
                    });
                });

                req.on('error', error => {
                    if (remaining > 0) {
                        setTimeout(() => attempt(remaining - 1), 1000);
                    } else if (this.lastQuota) {
                        console.warn('Quota connection error, returning cached data');
                        resolve(this.lastQuota);
                    } else {
                        reject(error);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    if (remaining > 0) {
                        attempt(remaining - 1);
                    } else if (this.lastQuota) {
                        console.warn('Quota timeout, returning cached data');
                        resolve(this.lastQuota);
                    } else {
                        reject(new Error('API request timed out'));
                    }
                });

                req.write(data);
                req.end();
            };

            attempt(retries);
        });
    }


    // Determine which group a model belongs to based on its label
    private getGroupForModel(label: string): { groupName: string; groupId: string } {
        const lowerLabel = label.toLowerCase();

        if (lowerLabel.includes('claude')) {
            return { groupName: 'Claude', groupId: 'claude' };
        }
        if (lowerLabel.includes('gemini') && lowerLabel.includes('flash')) {
            return { groupName: 'Gemini 3 Flash', groupId: 'gemini-flash' };
        }
        if (lowerLabel.includes('gemini') && lowerLabel.includes('pro')) {
            return { groupName: 'Gemini 3 Pro', groupId: 'gemini-pro' };
        }
        if (lowerLabel.includes('gpt')) {
            return { groupName: 'GPT', groupId: 'gpt' };
        }

        return { groupName: 'Other', groupId: 'other' };
    }

    // Process API response and return grouped quotas
    processQuotaResponse(response: any): GroupedQuota[] {
        if (!response || !response.userStatus) return [];
        const userStatus = response.userStatus;

        // Temporary map to collect models by group
        const groupMap: Map<string, {
            groupName: string;
            groupId: string;
            models: QuotaInfo[];
            worstRemainingFraction: number;
            latestResetTime: string;
        }> = new Map();

        const modelConfigs = (userStatus.cascadeModelConfigData && userStatus.cascadeModelConfigData.clientModelConfigs) ||
            (userStatus.modelConfigData && userStatus.modelConfigData.clientModelConfigs) ||
            (userStatus.clientModelConfigs);

        if (modelConfigs) {
            for (const config of modelConfigs) {
                const label = config.label || config.modelName || 'Unknown Model';
                const quotaInfo = config.quotaInfo || {};
                const resetTime = quotaInfo.resetTime || '';

                // Smart Default: If resetTime exists but fraction is missing, assume 0 (limited). Else 1.0 (unlimited).
                let defaultFraction = resetTime ? 0.0 : 1.0;

                const remainingFraction = typeof quotaInfo.remainingFraction === 'number' ? quotaInfo.remainingFraction : defaultFraction;
                const remainingPercent = Math.round(remainingFraction * 100);

                const modelInfo: QuotaInfo = {
                    modelName: label,
                    remaining: remainingPercent,
                    limit: 100,
                    resetDate: resetTime
                };

                // Determine group
                const { groupName, groupId } = this.getGroupForModel(label);

                if (!groupMap.has(groupId)) {
                    groupMap.set(groupId, {
                        groupName,
                        groupId,
                        models: [],
                        worstRemainingFraction: remainingFraction,
                        latestResetTime: resetTime
                    });
                }

                const group = groupMap.get(groupId)!;
                group.models.push(modelInfo);

                // Track worst (lowest) remaining fraction for the group
                if (remainingFraction < group.worstRemainingFraction) {
                    group.worstRemainingFraction = remainingFraction;
                }

                // Track latest reset time
                if (resetTime > group.latestResetTime) {
                    group.latestResetTime = resetTime;
                }
            }
        }

        // Convert map to array and sort by priority
        const priorityOrder = ['gemini-pro', 'gemini-flash', 'claude', 'gpt', 'other'];
        const result: GroupedQuota[] = [];

        for (const priority of priorityOrder) {
            if (groupMap.has(priority)) {
                const group = groupMap.get(priority)!;
                result.push({
                    groupName: group.groupName,
                    groupId: group.groupId,
                    remaining: Math.round(group.worstRemainingFraction * 100),
                    limit: 100,
                    resetDate: group.latestResetTime,
                    models: group.models
                });
            }
        }

        return result;
    }
}
