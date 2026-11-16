const { execFileSync } = require('node:child_process');
const { access, cp, mkdir, mkdtemp, realpath, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Arch } = require('builder-util');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

module.exports = async function buildMacWidget(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const architecture = { arm64: 'arm64', x64: 'x86_64' }[Arch[context.arch]];
  if (!architecture) throw new Error('Build each macOS widget architecture separately.');
  const target = architecture + '-apple-macos13.0';
  const { appInfo } = context.packager;
  const host = path.join(context.appOutDir, appInfo.productFilename + '.app', 'Contents');
  const extension = path.join(host, 'PlugIns', 'ArgusPipWidget.appex');
  const build = await mkdtemp(path.join(os.tmpdir(), 'argus-pip-widget-build-'));
  try {
    // An app-extension target emits the platform XPC entry point that WidgetKit launches.
    run('xcodebuild', ['-quiet', '-project', path.join(__dirname, 'ArgusPipWidget.xcodeproj'),
      '-target', 'ArgusPipWidget', '-configuration', 'Release', '-sdk', 'macosx',
      'ARCHS=' + architecture, 'ONLY_ACTIVE_ARCH=NO', 'CONFIGURATION_BUILD_DIR=' + build,
      'OBJROOT=' + path.join(build, 'objects'), 'SYMROOT=' + path.join(build, 'products'),
      'MARKETING_VERSION=' + appInfo.version, 'CURRENT_PROJECT_VERSION=' + appInfo.buildVersion,
      'CODE_SIGNING_ALLOWED=NO', 'build']);
    await mkdir(path.dirname(extension), { recursive: true });
    await cp(path.join(build, 'ArgusPipWidget.appex'), extension, { recursive: true });
    // The Electron signer skips this already-signed subtree to preserve its restricted sandbox.
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
      '--entitlements', path.join(__dirname, 'widget.entitlements'), extension]);

    // Node-API is ABI stable across the build-time Node and the bundled Electron runtime.
    const nodeHeaders = path.resolve(path.dirname(await realpath(process.execPath)), '..', 'include', 'node');
    await access(path.join(nodeHeaders, 'node_api.h'));
    const object = path.join(build, 'bridge.o');
    run('xcrun', ['--sdk', 'macosx', 'clang', '-target', target, '-I', nodeHeaders,
      '-c', path.join(__dirname, 'bridge.c'), '-o', object]);
    run('xcrun', ['--sdk', 'macosx', 'swiftc', '-target', target, '-emit-library', '-parse-as-library',
      '-O', path.join(__dirname, 'WidgetBridge.swift'), object, '-Xlinker', '-undefined',
      '-Xlinker', 'dynamic_lookup', '-o', path.join(host, 'Resources', 'argus-widget-bridge.node')]);
  } finally {
    await rm(build, { recursive: true, force: true });
  }
};
