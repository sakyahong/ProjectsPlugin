/* eslint-disable @typescript-eslint/no-var-requires */
const path = require('path');
const webpack = require('webpack');

/** @typedef {import('webpack').Configuration} WebpackConfig */

/** @type WebpackConfig */
const webExtensionConfig = {
    mode: 'none',
    target: 'webworker',
    entry: {
        'extension': './src/extension.ts'
    },
    output: {
        filename: '[name].js',
        path: path.join(__dirname, './dist'),
        libraryTarget: 'commonjs',
        devtoolModuleFilenameTemplate: '../../[resource-path]'
    },
    resolve: {
        mainFields: ['browser', 'module', 'main'],
        extensions: ['.ts', '.js'],
        fallback: {
            "path": require.resolve("path-browserify")
        }
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader'
                    }
                ]
            }
        ]
    },
    plugins: [
        new webpack.ProvidePlugin({
            process: 'process/browser',
        }),
    ],
    externals: {
        'vscode': 'commonjs vscode',
    },
    performance: {
        hints: false
    },
    devtool: 'nosources-source-map',
};

/** @type WebpackConfig */
const nodeExtensionConfig = {
    mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
    target: 'node', // extensions run in a node context
    entry: {
        'extension': './src/extension.ts'
    },
    output: {
        filename: '[name].js',
        path: path.join(__dirname, './dist'),
        libraryTarget: 'commonjs',
        devtoolModuleFilenameTemplate: '../../[resource-path]'
    },
    resolve: {
        mainFields: ['module', 'main'],
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader'
                    }
                ]
            }
        ]
    },
    externals: {
        'vscode': 'commonjs vscode', // ignored because it doesn't exist
    },
    performance: {
        hints: false
    },
    devtool: 'nosources-source-map',
};

module.exports = [nodeExtensionConfig];
