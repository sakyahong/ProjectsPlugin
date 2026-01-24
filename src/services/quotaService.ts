import * as https from 'https';

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
    constructor() { }

    async getUserStatus(port: number, csrfToken: string): Promise<any> {
        return new Promise((resolve, reject) => {
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
                    'Content-Length': data.length,
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Connect-Protocol-Version': '1'
                },
                rejectUnauthorized: false
            };

            const req = https.request(options, res => {
                let responseData = '';
                res.on('data', chunk => { responseData += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(responseData));
                        } catch (e) {
                            reject(new Error('Failed to parse response'));
                        }
                    } else {
                        reject(new Error(`API request failed with status ${res.statusCode}`));
                    }
                });
            });

            req.on('error', error => { reject(error); });
            req.write(data);
            req.end();
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

        if (userStatus.cascadeModelConfigData && userStatus.cascadeModelConfigData.clientModelConfigs) {
            const configs = userStatus.cascadeModelConfigData.clientModelConfigs;

            for (const config of configs) {
                const label = config.label || 'Unknown Model';
                const quotaInfo = config.quotaInfo || {};
                const remainingFraction = typeof quotaInfo.remainingFraction === 'number' ? quotaInfo.remainingFraction : 1.0;
                const remainingPercent = Math.round(remainingFraction * 100);
                const resetTime = quotaInfo.resetTime || '';

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
