const { existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const spawn = require('cross-spawn');
const { exec: packageExecutable } = require('pkg');
const { dependencies } = require('./package.json');

const bindings = {
    'node18-win-x64': 'win32-x64-msvc',
    'node18-linux-x64': 'linux-x64-gnu',
    'node18-macos-x64': 'darwin-x64',
    'node18-macos-arm64': 'darwin-arm64',
};

async function main() {
    const targets = process.argv.slice(2);
    if (!targets.length || targets.some(target => !Object.hasOwn(bindings, target))) {
        throw new Error('Provide one or more supported pkg targets');
    }

    const coreDir = __dirname;
    const stagingDir = path.join(coreDir, 'dist', 'pkg-libsql');
    process.chdir(coreDir);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    try {
        // npm installs the explicitly selected prebuilts even when packaging from another platform.
        const version = dependencies.libsql;
        const nativeTargets = [...new Set(targets.map(target => bindings[target]))];
        const nativePackages = nativeTargets.map(binding => `@libsql/${binding}@${version}`);
        const result = spawn.sync('npm', [
            'install', '--prefix', stagingDir, '--force', '--ignore-scripts', '--omit=optional',
            '--no-save', '--package-lock=false', '--no-audit', '--no-fund',
            `libsql@${version}`, ...nativePackages,
        ], { stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('Installing pkg SQLite binaries failed');
        for (const target of nativeTargets) {
            if (!existsSync(path.join(stagingDir, 'node_modules', '@libsql', target, 'index.node'))) {
                throw new Error(`Missing libSQL binary for ${target}`);
            }
        }

        await packageExecutable(['.', '--no-bytecode', '--no-native-build',
            '--targets', targets.join(','), '--out-path', 'dist/bin']);
    } finally {
        rmSync(stagingDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
