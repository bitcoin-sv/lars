#!/usr/bin/env node

import { program } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import figlet from 'figlet';
import { spawn, execSync } from 'child_process';
import chokidar from 'chokidar';
import yaml from 'yaml';
import crypto from 'crypto';
import ngrok from 'ngrok';
import { Ninja } from 'ninja-base';
import { getPublicKey, createAction, getVersion } from '@babbage/sdk-ts';
import { P2PKH, PrivateKey, PublicKey } from '@bsv/sdk';

/////////////////////////////////////////////////////////////////////////////////////
// Constants and Types
/////////////////////////////////////////////////////////////////////////////////////

interface CARSConfig {
    name: string;
    network?: string;
    provider: string;
    projectID?: string;
    CARSCloudURL?: string;
    deploy?: string[];
    frontendHostingMethod?: string;
    authentication?: any;
    payments?: any;
    run?: string[]; // For LARS only
}

interface CARSConfigInfo {
    schema: string;
    schemaVersion: string;
    topicManagers?: Record<string, string>;
    lookupServices?: Record<string, { serviceFactory: string; hydrateWith?: string }>;
    frontend?: { language: string; sourceDirectory: string };
    contracts?: { language: string; baseDirectory: string };
    configs?: CARSConfig[];
}

interface LARSConfigLocal {
    // Project-level config
    // Overridden from global if specified
    serverPrivateKey?: string;
    arcApiKey?: string;
    enableRequestLogging?: boolean;
    enableGASPSync?: boolean;
}

interface GlobalKeys {
    mainnet?: {
        serverPrivateKey?: string;
        taalApiKey?: string;
    };
    testnet?: {
        serverPrivateKey?: string;
        taalApiKey?: string;
    };
}

/////////////////////////////////////////////////////////////////////////////////////
// File paths
/////////////////////////////////////////////////////////////////////////////////////

const PROJECT_ROOT = process.cwd();
const DEPLOYMENT_INFO_PATH = path.join(PROJECT_ROOT, 'deployment-info.json');
const LOCAL_DATA_PATH = path.resolve(PROJECT_ROOT, 'local-data');
const LARS_CONFIG_PATH = path.join(LOCAL_DATA_PATH, 'lars-config.json');
const GLOBAL_KEYS_PATH = path.join(os.homedir(), '.lars-keys.json');

/////////////////////////////////////////////////////////////////////////////////////
// Default LARS config
/////////////////////////////////////////////////////////////////////////////////////

function getDefaultProjectConfig(): LARSConfigLocal {
    return {
        serverPrivateKey: undefined,
        arcApiKey: undefined,
        enableRequestLogging: true,
        enableGASPSync: false
    };
}

/////////////////////////////////////////////////////////////////////////////////////
// Utility functions
/////////////////////////////////////////////////////////////////////////////////////

function loadDeploymentInfo(): CARSConfigInfo {
    if (!fs.existsSync(DEPLOYMENT_INFO_PATH)) {
        console.error(chalk.red('❌ deployment-info.json not found in the current directory.'));
        process.exit(1);
    }
    const info = JSON.parse(fs.readFileSync(DEPLOYMENT_INFO_PATH, 'utf-8'));
    info.configs = info.configs || [];
    return info;
}

function getLARSConfigFromDeploymentInfo(info: CARSConfigInfo): CARSConfig | undefined {
    // Find the LARS config (provider === 'LARS')
    const larsConfig = info.configs?.find(c => c.provider === 'LARS');
    return larsConfig;
}

function ensureLocalDataDir() {
    fs.ensureDirSync(LOCAL_DATA_PATH);
}

function loadOrInitGlobalKeys(): GlobalKeys {
    let keys: GlobalKeys = {};
    if (fs.existsSync(GLOBAL_KEYS_PATH)) {
        keys = JSON.parse(fs.readFileSync(GLOBAL_KEYS_PATH, 'utf-8'));
    }
    keys.mainnet = keys.mainnet || {};
    keys.testnet = keys.testnet || {};
    return keys;
}

function saveGlobalKeys(keys: GlobalKeys) {
    fs.writeFileSync(GLOBAL_KEYS_PATH, JSON.stringify(keys, null, 2));
}

function loadProjectConfig(): LARSConfigLocal {
    if (!fs.existsSync(LARS_CONFIG_PATH)) {
        return getDefaultProjectConfig();
    }
    const existingConfig = JSON.parse(fs.readFileSync(LARS_CONFIG_PATH, 'utf-8'));
    return { ...getDefaultProjectConfig(), ...existingConfig };
}

function saveProjectConfig(config: LARSConfigLocal) {
    ensureLocalDataDir();
    fs.writeFileSync(LARS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function promptForPrivateKey(): Promise<string> {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Do you want to generate a new private key or enter an existing one?',
            choices: [
                { name: '🔑 Generate new key', value: 'generate' },
                { name: '✏️ Enter existing key', value: 'enter' }
            ],
        },
    ]);

    if (action === 'generate') {
        const key = crypto.randomBytes(32).toString('hex');
        console.log(chalk.green('✨ New private key generated.'));
        return key;
    } else {
        const { enteredKey } = await inquirer.prompt([
            {
                type: 'password',
                name: 'enteredKey',
                message: 'Enter your private key (64-char hex):',
                mask: '*',
                validate: function (value: string) {
                    if (/^[0-9a-fA-F]{64}$/.test(value)) {
                        return true;
                    }
                    return 'Please enter a valid 64-character hexadecimal string.';
                },
            },
        ]);
        const key = enteredKey.toLowerCase();
        console.log(chalk.green('🔐 Private key set.'));
        return key;
    }
}

async function promptForArcApiKey(): Promise<string | undefined> {
    const { setArcKey } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'setArcKey',
            message: 'Do you have a TAAL (ARC) API key to set? (optional)',
            default: false
        }
    ]);

    if (!setArcKey) {
        return undefined;
    }

    const { enteredArcKey } = await inquirer.prompt([
        {
            type: 'input',
            name: 'enteredArcKey',
            message: 'Enter your TAAL (ARC) API key:',
        },
    ]);

    const arcApiKey = enteredArcKey.trim();
    console.log(chalk.green('🔑 TAAL (ARC) API key set.'));
    return arcApiKey;
}

async function promptYesNo(message: string, defaultVal = true): Promise<boolean> {
    const { answer } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'answer',
            message,
            default: defaultVal
        }
    ]);
    return answer;
}

async function fundNinja(ninja: Ninja, amount: number, ninjaPriv: string) {
    const derivationPrefix = crypto.randomBytes(10).toString('base64');
    const derivationSuffix = crypto.randomBytes(10).toString('base64');
    const derivedPublicKey = await getPublicKey({
        counterparty: new PrivateKey(ninjaPriv, 'hex').toPublicKey().toString(),
        protocolID: '3241645161d8',
        keyID: `${derivationPrefix} ${derivationSuffix}`
    });
    const script = new P2PKH().lock(PublicKey.fromString(derivedPublicKey).toAddress()).toHex();
    const outputs = [{
        script,
        satoshis: amount
    }];
    const transaction = await createAction({
        outputs,
        description: 'Funding Local Overlay Services host for development'
    });
    transaction.outputs = [{
        vout: 0,
        satoshis: amount,
        derivationSuffix
    }];
    const directTransaction = {
        derivationPrefix,
        transaction,
        senderIdentityKey: await getPublicKey({ identityKey: true }),
        protocol: '3241645161d8' as any,
        note: 'Incoming payment from KeyFunder'
    };
    await ninja.submitDirectTransaction(directTransaction);
    console.log(chalk.green('🎉 Ninja funded!'));
}

/////////////////////////////////////////////////////////////////////////////////////
// Configuration and Menu Systems
/////////////////////////////////////////////////////////////////////////////////////

// Edit local project config interactively
async function editLocalConfig(larsConfig: LARSConfigLocal, network: 'mainnet' | 'testnet') {
    // We'll allow toggling request logging, GASP sync, and changing keys.
    // Also allow setting project-level overrides for keys, or revert to global keys.

    // Load global keys
    const globalKeys = loadOrInitGlobalKeys();

    // Determine current effective serverPrivateKey and arcApiKey:
    const effectiveServerKey = larsConfig.serverPrivateKey || globalKeys[network]?.serverPrivateKey;
    const effectiveArcApiKey = larsConfig.arcApiKey || globalKeys[network]?.taalApiKey;

    // We'll present a menu:
    let done = false;
    while (!done) {
        console.log(chalk.blue(`\nProject config menu (Network: ${network})`));
        const choices = [
            { name: `Server private key: ${effectiveServerKey ? '(set)' : '(not set)'} (project-level: ${larsConfig.serverPrivateKey ? 'yes' : 'no'})`, value: 'serverKey' },
            { name: `TAAL (ARC) API key: ${effectiveArcApiKey ? '(set)' : '(not set)'} (project-level: ${larsConfig.arcApiKey ? 'yes' : 'no'})`, value: 'arcKey' },
            { name: `Request logging: ${larsConfig.enableRequestLogging ? 'enabled' : 'disabled'}`, value: 'reqlog' },
            { name: `GASP sync: ${larsConfig.enableGASPSync ? 'enabled' : 'disabled'}`, value: 'gasp' },
            { name: 'Done', value: 'done' }
        ];

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select an action:',
                choices
            }
        ]);

        if (action === 'serverKey') {
            const { action: keyAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'Manage server private key:',
                    choices: [
                        { name: 'Set project-level key', value: 'set' },
                        { name: 'Use global key', value: 'useGlobal' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ]);
            if (keyAction === 'set') {
                larsConfig.serverPrivateKey = await promptForPrivateKey();
            } else if (keyAction === 'useGlobal') {
                larsConfig.serverPrivateKey = undefined;
            }
            saveProjectConfig(larsConfig);
        } else if (action === 'arcKey') {
            const { action: keyAction } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'Manage TAAL (ARC) API key:',
                    choices: [
                        { name: 'Set project-level key', value: 'set' },
                        { name: 'Use global key', value: 'useGlobal' },
                        { name: 'Unset project-level key', value: 'unset' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ]);
            if (keyAction === 'set') {
                const newArc = await promptForArcApiKey();
                if (newArc) {
                    larsConfig.arcApiKey = newArc;
                }
            } else if (keyAction === 'useGlobal' || keyAction === 'unset') {
                larsConfig.arcApiKey = undefined;
            }
            saveProjectConfig(larsConfig);
        } else if (action === 'reqlog') {
            larsConfig.enableRequestLogging = !larsConfig.enableRequestLogging;
            saveProjectConfig(larsConfig);
        } else if (action === 'gasp') {
            larsConfig.enableGASPSync = !larsConfig.enableGASPSync;
            saveProjectConfig(larsConfig);
        } else {
            done = true;
        }
    }
}

// Edit global keys
async function editGlobalKeys() {
    const keys = loadOrInitGlobalKeys();

    let done = false;
    while (!done) {
        console.log(chalk.blue('\nGlobal Keys Menu'));
        console.log(chalk.gray('Global keys apply to all LARS projects unless overridden at project level.'));
        const choices = [
            { name: `Mainnet server key: ${keys.mainnet?.serverPrivateKey ? 'set' : 'not set'}`, value: 'm_serverKey' },
            { name: `Mainnet TAAL (ARC) key: ${keys.mainnet?.taalApiKey ? 'set' : 'not set'}`, value: 'm_arcKey' },
            { name: `Testnet server key: ${keys.testnet?.serverPrivateKey ? 'set' : 'not set'}`, value: 't_serverKey' },
            { name: `Testnet TAAL (ARC) key: ${keys.testnet?.taalApiKey ? 'set' : 'not set'}`, value: 't_arcKey' },
            { name: 'Back', value: 'back' }
        ];

        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'Choose an option:', choices }
        ]);

        if (action === 'back') {
            done = true;
            continue;
        }

        const network = action.startsWith('m_') ? 'mainnet' : 'testnet';
        const field = action.endsWith('serverKey') ? 'serverPrivateKey' : 'taalApiKey';
        if (field === 'serverPrivateKey') {
            keys[network]!.serverPrivateKey = await promptForPrivateKey();
        } else {
            const newArc = await promptForArcApiKey();
            if (newArc) {
                keys[network]!.taalApiKey = newArc;
            }
        }
        saveGlobalKeys(keys);
        console.log(chalk.green('Global keys updated.'));
    }
}

// Main menu
async function mainMenu() {
    const info = loadDeploymentInfo();
    let larsConfig = getLARSConfigFromDeploymentInfo(info);
    const projectConfig = loadProjectConfig();

    if (!larsConfig) {
        console.log(chalk.yellow('No LARS configuration found in deployment-info.json.'));
        // Prompt to create one
        await addLARSConfigInteractive(info);
        larsConfig = getLARSConfigFromDeploymentInfo(info);
    }

    if (!larsConfig) {
        console.error(chalk.red('Failed to create or find LARS configuration.'));
        process.exit(1);
    }

    // Ensure we have a network
    const network = larsConfig.network === 'mainnet' ? 'mainnet' : 'testnet';

    let done = false;
    while (!done) {
        const choices = [
            { name: 'Edit Global Keys', value: 'globalKeys' },
            { name: 'Edit Local Project Config', value: 'localConfig' },
            { name: 'Start LARS', value: 'start' },
            { name: 'Exit', value: 'exit' }
        ];

        console.log(chalk.blue('\nLARS Main Menu'));
        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: 'Select an action:', choices }
        ]);

        if (action === 'globalKeys') {
            await editGlobalKeys();
        } else if (action === 'localConfig') {
            await editLocalConfig(projectConfig, network);
        } else if (action === 'start') {
            await startLARS(larsConfig, projectConfig);
        } else {
            done = true;
        }
    }
}

// Add LARS config interactively if none exists
async function addLARSConfigInteractive(info: CARSConfigInfo) {
    console.log(chalk.blue('Let’s create a LARS configuration.'));
    const { network } = await inquirer.prompt([
        {
            type: 'list',
            name: 'network',
            message: 'Select network for LARS:',
            choices: ['mainnet', 'testnet'],
            default: 'testnet'
        }
    ]);

    const newCfg: CARSConfig = {
        name: 'Local LARS',
        network,
        provider: 'LARS',
        run: ['backend']
    };
    info.configs = info.configs || [];
    info.configs.push(newCfg);
    fs.writeFileSync(DEPLOYMENT_INFO_PATH, JSON.stringify(info, null, 2));
    console.log(chalk.green(`✅ LARS configuration "Local LARS" created with network: ${network}.`));
}

// Start LARS
async function startLARS(larsConfig: CARSConfig, projectConfig: LARSConfigLocal) {
    console.log(
        chalk.yellow(
            figlet.textSync('LARS', { horizontalLayout: 'full' })
        )
    );
    console.log(chalk.green('Welcome to the LARS development environment! 🚀'));
    console.log(chalk.green("Let's get your local Overlay Services up and running!\n"));

    // Load global keys
    const globalKeys = loadOrInitGlobalKeys();
    const network = larsConfig.network === 'mainnet' ? 'mainnet' : 'testnet';

    // Determine final keys:
    let finalServerKey = projectConfig.serverPrivateKey || globalKeys[network]?.serverPrivateKey;
    let finalArcKey = projectConfig.arcApiKey || globalKeys[network]?.taalApiKey;

    // If no server key at all, ask user to set either global or project-level:
    if (!finalServerKey) {
        console.log(chalk.yellow(`No server private key found for ${network}.`));
        const useGlobal = await promptYesNo(`Set a global server key for ${network}?`);
        if (useGlobal) {
            const key = await promptForPrivateKey();
            globalKeys[network]!.serverPrivateKey = key;
            saveGlobalKeys(globalKeys);
            finalServerKey = key;
        } else {
            // set project-level
            const key = await promptForPrivateKey();
            projectConfig.serverPrivateKey = key;
            saveProjectConfig(projectConfig);
            finalServerKey = key;
        }
    }

    // Now finalServerKey should be set
    if (!finalServerKey) {
        console.error(chalk.red('❌ Server private key is required. Exiting.'));
        process.exit(1);
    }

    // Check dependencies
    console.log(chalk.blue('🔍 Checking system dependencies...'));
    // Docker
    try {
        execSync('docker --version', { stdio: 'ignore' });
    } catch (err) {
        console.error(chalk.red('❌ Docker is not installed or not running.'));
        console.log(chalk.blue('👉 Install Docker: https://docs.docker.com/engine/install/'));
        process.exit(1);
    }
    // Docker Compose
    try {
        execSync('docker compose version', { stdio: 'ignore' });
    } catch (err) {
        console.error(chalk.red('❌ Docker Compose plugin is not installed.'));
        console.log(chalk.blue('👉 Install Docker Compose: https://docs.docker.com/compose/install/'));
        process.exit(1);
    }
    // ngrok
    try {
        execSync('ngrok version', { stdio: 'ignore' });
    } catch (err) {
        console.error(chalk.red('❌ ngrok is not installed.'));
        console.log(chalk.blue('👉 Install ngrok: https://ngrok.com/download'));
        process.exit(1);
    }
    // MetaNet Client
    try {
        await getVersion();
    } catch (err) {
        console.error(chalk.red('❌ MetaNet Client is not installed or not running.'));
        console.log(chalk.blue('👉 Download MetaNet Client: https://projectbabbage.com/'));
        process.exit(1);
    }

    // Start ngrok
    console.log(chalk.blue('🌐 Starting ngrok...'));
    const ngrokUrl = await ngrok.connect({ addr: 8080 });
    console.log(chalk.green(`🚀 ngrok tunnel established at ${ngrokUrl}`));

    // Check server funding
    const ninja = new Ninja({ privateKey: finalServerKey });
    const { total: balance } = await ninja.getTotalValue();
    if (balance < 10000) {
        console.log(chalk.red(`⚠️  Your server's balance is low: ${balance} satoshis.`));
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Your server\'s balance is low. What would you like to do?',
                choices: [
                    '💰 Fund server automatically (using local MetaNet Client)',
                    '📝 Print manual funding instructions',
                    '🚀 Continue without funding',
                ],
            },
        ]);

        if (action.startsWith('💰')) {
            const { amountToFund } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'amountToFund',
                    message: 'Enter the amount to fund (in satoshis):',
                    default: '30000',
                    validate: function (value: string) {
                        const valid = !isNaN(parseInt(value)) && parseInt(value) > 0;
                        return valid || 'Please enter a positive number.';
                    },
                    filter: Number,
                },
            ]);
            await fundNinja(ninja, amountToFund, finalServerKey);
            console.log(chalk.green(`🎉 Server funded with ${amountToFund} satoshis.`));
        } else if (action.startsWith('📝')) {
            console.log(chalk.blue('\nManual Funding Instructions:'));
            console.log(`1. Use KeyFunder to fund your server.`);
            console.log(`2. Your server's Ninja private key is: ${finalServerKey}`);
            console.log('3. Visit https://keyfunder.babbage.systems and follow the instructions.');
            await inquirer.prompt([
                {
                    type: 'input',
                    name: 'wait',
                    message: 'Press enter when you\'re ready to continue.',
                },
            ]);
        } else {
            console.log(chalk.yellow('🚀 Continuing without funding.'));
        }
    } else {
        console.log(chalk.green(`✅ Server balance is sufficient: ${balance} satoshis.`));
    }

    // Check contracts
    const info = loadDeploymentInfo();
    let enableContracts = false;
    if (info.contracts && info.contracts.language === 'sCrypt') {
        enableContracts = true;
    } else if (info.contracts && info.contracts.language && info.contracts.language !== 'sCrypt') {
        console.error(chalk.red(`❌ BSV Contract language not supported: ${info.contracts.language}`));
        process.exit(1);
    }

    // Generate docker-compose.yml
    console.log(chalk.blue('\n📝 Generating docker-compose.yml...'));
    ensureLocalDataDir();
    const composeContent = generateDockerCompose(ngrokUrl, LOCAL_DATA_PATH, finalServerKey, enableContracts, network, finalArcKey, projectConfig.enableRequestLogging!, projectConfig.enableGASPSync!);
    const composeYaml = yaml.stringify(composeContent);
    const composeFilePath = path.join(LOCAL_DATA_PATH, 'docker-compose.yml');
    fs.writeFileSync(composeFilePath, composeYaml);
    console.log(chalk.green('✅ docker-compose.yml generated.'));

    // Generate overlay-dev-container files
    console.log(chalk.blue('\n📁 Generating overlay-dev-container files...'));
    const overlayDevContainerPath = path.join(LOCAL_DATA_PATH, 'overlay-dev-container');
    fs.ensureDirSync(overlayDevContainerPath);

    const indexTsContent = generateIndexTs(info, projectConfig, finalArcKey, network);
    fs.writeFileSync(path.join(overlayDevContainerPath, 'index.ts'), indexTsContent);

    // Read backend dependencies if available
    const backendPackageJsonPath = path.resolve(PROJECT_ROOT, 'backend', 'package.json');
    let backendDependencies: Record<string, string> = {};
    if (fs.existsSync(backendPackageJsonPath)) {
        const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf-8'));
        backendDependencies = backendPackageJson.dependencies || {};
    } else {
        console.warn(chalk.yellow('⚠️  No backend/package.json found.'));
    }

    const packageJsonContent = generatePackageJson(backendDependencies);
    fs.writeFileSync(path.join(overlayDevContainerPath, 'package.json'), JSON.stringify(packageJsonContent, null, 2));
    fs.writeFileSync(path.join(overlayDevContainerPath, 'tsconfig.json'), generateTsConfig());
    fs.writeFileSync(path.join(overlayDevContainerPath, 'wait-for-services.sh'), generateWaitScript());
    fs.writeFileSync(path.join(overlayDevContainerPath, 'Dockerfile'), generateDockerfile(enableContracts));
    console.log(chalk.green('✅ overlay-dev-container files generated.'));

    // Start Docker Compose
    console.log(chalk.blue('\n🐳 Starting Docker Compose...'));
    const dockerComposeUp = spawn('docker', ['compose', 'up', '--build'], {
        cwd: LOCAL_DATA_PATH,
        stdio: 'inherit'
    });

    dockerComposeUp.on('exit', (code) => {
        if (code === 0) {
            console.log(chalk.green(`🐳 Docker Compose going down.`));
        } else {
            console.log(chalk.red(`❌ Docker Compose exited with code ${code}`));
        }
        console.log(chalk.blue(`👋 LARS will see you next time!`));
        process.exit(0);
    });

    // Set up file watchers
    console.log(chalk.blue('\n👀 Setting up file watchers...'));
    const backendSrcPath = path.resolve(PROJECT_ROOT, 'backend', 'src');
    const watcher = chokidar.watch(backendSrcPath, { ignoreInitial: true });
    watcher.on('all', (event, filePath) => {
        console.log(chalk.yellow(`🔄 File ${event}: ${filePath}`));
        if (filePath.includes(path.join('backend', 'src', 'contracts')) && enableContracts) {
            console.log(chalk.blue('🔨 Changes detected in contracts directory. Running npm run compile...'));
            const compileProcess = spawn('npm', ['run', 'compile'], {
                cwd: path.resolve(PROJECT_ROOT, 'backend'),
                stdio: 'inherit'
            });

            compileProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log(chalk.green('✅ Contract compilation completed.'));
                } else {
                    console.error(chalk.red(`❌ Contract compilation failed with exit code ${code}.`));
                }
            });
        }
    });

    console.log(chalk.green('\n🎉 LARS development environment is up and running! Happy coding!'));
}

/////////////////////////////////////////////////////////////////////////////////////
// Generation of config files
/////////////////////////////////////////////////////////////////////////////////////

function generateDockerCompose(
    hostingUrl: string,
    localDataPath: string,
    serverPrivateKey: string,
    enableContracts: boolean,
    network: 'mainnet' | 'testnet',
    arcApiKey: string | undefined,
    reqLogging: boolean,
    gaspSync: boolean
) {
    const env: Record<string, string> = {
        MONGO_URL: 'mongodb://mongo:27017/overlay-db',
        KNEX_URL: 'mysql://overlayAdmin:overlay123@mysql:3306/overlay',
        SERVER_PRIVATE_KEY: serverPrivateKey,
        HOSTING_URL: hostingUrl,
        NETWORK: network
    };
    if (arcApiKey) {
        env.ARC_API_KEY = arcApiKey;
    }
    env.REQUEST_LOGGING = reqLogging ? 'true' : 'false';
    env.GASP_SYNC = gaspSync ? 'true' : 'false';

    const composeContent: any = {
        services: {
            'overlay-dev-container': {
                build: {
                    context: '..',
                    dockerfile: './local-data/overlay-dev-container/Dockerfile'
                },
                container_name: 'overlay-dev-container',
                restart: 'always',
                ports: [
                    '8080:8080'
                ],
                environment: env,
                depends_on: [
                    'mysql',
                    'mongo'
                ],
                volumes: [
                    `${path.resolve(PROJECT_ROOT, 'backend', 'src')}:/app/src`
                ]
            },
            mysql: {
                image: 'mysql:8.0',
                container_name: 'overlay-mysql',
                environment: {
                    MYSQL_DATABASE: 'overlay',
                    MYSQL_USER: 'overlayAdmin',
                    MYSQL_PASSWORD: 'overlay123',
                    MYSQL_ROOT_PASSWORD: 'rootpassword'
                },
                ports: [
                    '3306:3306'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'mysql')}:/var/lib/mysql`
                ],
                healthcheck: {
                    test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
                    interval: '10s',
                    timeout: '5s',
                    retries: 3
                }
            },
            mongo: {
                image: 'mongo:6.0',
                container_name: 'overlay-mongo',
                ports: [
                    '27017:27017'
                ],
                volumes: [
                    `${path.resolve(localDataPath, 'mongo')}:/data/db`
                ],
                command: ["mongod", "--quiet"]
            }
        }
    };
    if (enableContracts) {
        composeContent.services['overlay-dev-container'].volumes.push(`${path.resolve(PROJECT_ROOT, 'backend', 'artifacts')}:/app/artifacts`);
    }
    return composeContent;
}

function generateIndexTs(info: CARSConfigInfo, config: LARSConfigLocal, arcApiKey: string | undefined, network: 'mainnet' | 'testnet'): string {
    let imports = `
import OverlayExpress from '@bsv/overlay-express'
`;

    let mainFunction = `
const main = async () => {
    const server = new OverlayExpress(
        \`LARS\`,
        process.env.SERVER_PRIVATE_KEY!,
        process.env.HOSTING_URL!
    )

    server.configurePort(8080)
    server.configureVerboseRequestLogging(process.env.REQUEST_LOGGING === 'true')
    server.configureNetwork(process.env.NETWORK === 'mainnet' ? 'main' : 'test')
    await server.configureKnex(process.env.KNEX_URL!)
    await server.configureMongo(process.env.MONGO_URL!)
    server.configureEnableGASPSync(process.env.GASP_SYNC === 'true')
`;

    if (arcApiKey) {
        mainFunction += `    server.configureArcApiKey(process.env.ARC_API_KEY!)\n`;
    }

    // For each topic manager
    for (const [name, pathToTm] of Object.entries(info.topicManagers || {})) {
        const importName = `tm_${name}`;
        const pathToTmInContainer = path.join('/app', path.relative(process.cwd(), pathToTm)).replace(/\\/g, '/').replace('/backend/', '/');
        imports += `import ${importName} from '${pathToTmInContainer}'\n`;
        mainFunction += `    server.configureTopicManager('${name}', new ${importName}())\n`;
    }

    // For each lookup service
    for (const [name, lsConfig] of Object.entries(info.lookupServices || {})) {
        const importName = `lsf_${name}`;
        const pathToLsInContainer = path.join('/app', path.relative(process.cwd(), lsConfig.serviceFactory)).replace(/\\/g, '/').replace('/backend/', '/');
        imports += `import ${importName} from '${pathToLsInContainer}'\n`;
        if (lsConfig.hydrateWith === 'mongo') {
            mainFunction += `    server.configureLookupServiceWithMongo('${name}', ${importName})\n`;
        } else if (lsConfig.hydrateWith === 'knex') {
            mainFunction += `    server.configureLookupServiceWithKnex('${name}', ${importName})\n`;
        } else {
            mainFunction += `    server.configureLookupService('${name}', ${importName}())\n`;
        }
    }

    mainFunction += `
    await server.configureEngine()
    await server.start()
}

main()`;

    const indexTsContent = imports + mainFunction;
    return indexTsContent;
}

function generatePackageJson(backendDependencies: Record<string, string>) {
    const packageJsonContent = {
        "name": "overlay-express-dev",
        "version": "1.0.0",
        "description": "",
        "main": "index.ts",
        "scripts": {
            "start": "tsx watch index.ts"
        },
        "keywords": [],
        "author": "",
        "license": "ISC",
        "dependencies": {
            ...backendDependencies,
            "@bsv/overlay-express": "^0.1.9",
            "mysql2": "^3.11.5",
            "tsx": "^4.19.2"
        },
        "devDependencies": {
            "@types/node": "^22.10.1"
        }
    };
    return packageJsonContent;
}

function generateDockerfile(enableContracts: boolean) {
    let file = `FROM node:22-alpine
WORKDIR /app
COPY ./local-data/overlay-dev-container/package.json .
RUN npm i
COPY ./local-data/overlay-dev-container/index.ts .
COPY ./local-data/overlay-dev-container/tsconfig.json .
COPY ./local-data/overlay-dev-container/wait-for-services.sh /wait-for-services.sh
RUN chmod +x /wait-for-services.sh`
    if (enableContracts) {
        file += `
COPY ./backend/artifacts ./artifacts`
    }
    file += `
COPY ./backend/src ./src

EXPOSE 8080
CMD ["/wait-for-services.sh", "mysql", "3306", "mongo", "27017", "npm", "run", "start"]`;
    return file;
}

function generateTsConfig() {
    return `{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}`;
}

function generateWaitScript() {
    return `#!/bin/sh

set -e

host1="$1"
port1="$2"
host2="$3"
port2="$4"
shift 4

echo "Waiting for $host1:$port1..."
while ! nc -z $host1 $port1; do
  sleep 1
done
echo "$host1:$port1 is up"

echo "Waiting for $host2:$port2..."
while ! nc -z $host2 $port2; do
  sleep 1
done
echo "$host2:$port2 is up"

exec "$@"`
}

/////////////////////////////////////////////////////////////////////////////////////
// CLI Commands
/////////////////////////////////////////////////////////////////////////////////////

program
    .command('config')
    .description('Edit LARS configuration (local project config and global keys)')
    .action(async () => {
        const info = loadDeploymentInfo();
        let larsConfig = getLARSConfigFromDeploymentInfo(info);
        if (!larsConfig) {
            console.log(chalk.yellow('No LARS configuration found. Creating one.'));
            await addLARSConfigInteractive(info);
            larsConfig = getLARSConfigFromDeploymentInfo(info);
        }
        if (!larsConfig) {
            console.error(chalk.red('Failed to create/find LARS configuration.'));
            process.exit(1);
        }

        const network = larsConfig.network === 'mainnet' ? 'mainnet' : 'testnet';
        const projectConfig = loadProjectConfig();
        // Present a menu similar to main menu but only config
        await editGlobalKeys();
        await editLocalConfig(projectConfig, network);
    });

program
    .command('start')
    .description('Start LARS development environment')
    .action(async () => {
        const info = loadDeploymentInfo();
        const larsConfig = getLARSConfigFromDeploymentInfo(info);
        if (!larsConfig) {
            console.log(chalk.yellow('No LARS configuration found. Creating one.'));
            await addLARSConfigInteractive(info);
        }
        const finalConfig = getLARSConfigFromDeploymentInfo(info);
        if (!finalConfig) {
            console.error(chalk.red('Failed to create/find LARS configuration.'));
            process.exit(1);
        }
        const projectConfig = loadProjectConfig();
        await startLARS(finalConfig, projectConfig);
    });

program
    .action(async () => {
        // If `lars` is run without arguments, show main menu
        await mainMenu();
    });

program.parse(process.argv);