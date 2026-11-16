import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [app, arch] = process.argv.slice(2)
assert.ok(app && ['arm64', 'x86_64'].includes(arch), 'Expected app bundle path and Mach-O architecture')
const contents = join(app, 'Contents')
const extension = join(contents, 'PlugIns', 'ArgusPipWidget.appex')
const widgetBinary = join(extension, 'Contents', 'MacOS', 'ArgusPipWidget')
const bridge = join(contents, 'Resources', 'argus-widget-bridge.node')
function command(tool, ...args) {
  return execFileSync(tool, args, { encoding: 'utf8' })
}
function plist(file) {
  return JSON.parse(command('plutil', '-convert', 'json', '-o', '-', file))
}

const info = plist(join(extension, 'Contents', 'Info.plist'))
const appInfo = plist(join(contents, 'Info.plist'))
assert.equal(info.CFBundleIdentifier, appInfo.CFBundleIdentifier + '.Widget')
assert.equal(info.CFBundlePackageType, 'XPC!')
assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.widgetkit-extension')
assert.equal(info.CFBundleVersion, appInfo.CFBundleVersion)
assert.equal(info.CFBundleShortVersionString, appInfo.CFBundleShortVersionString)
assert.ok(appInfo.CFBundleURLTypes.some(type => type.CFBundleURLSchemes.includes('arguspip')))
const resources = join(extension, 'Contents', 'Resources')
const metadata = JSON.parse(readFileSync(join(resources, 'Metadata.appintents', 'extract.actionsdata'), 'utf8'))
assert.ok(metadata.actions?.ChannelSelectionIntent?.parameters?.some(parameter => parameter.name === 'channel'),
  'Channel picker needs its channel parameter in the installed App Intents metadata')
assert.ok(metadata.entities?.WidgetYouTubeChannel, 'Channel picker needs its channel entity')

command('codesign', '--verify', '--deep', '--strict', app)
const signedEntitlements = command('codesign', '--display', '--entitlements', '-', '--xml', extension)
const entitlements = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: signedEntitlements }))
assert.deepEqual(entitlements, {
  'com.apple.security.app-sandbox': true,
  'com.apple.security.temporary-exception.files.home-relative-path.read-only': [
    '/Library/Application Support/Creator Dashboard Desktop/widget-snapshot.json'
  ]
})
for (const binary of [widgetBinary, bridge]) command('lipo', binary, '-verify_arch', arch)

// A plain Swift executable also registers with PlugInKit but crashes when WidgetKit requests its descriptor.
const commands = command('xcrun', 'otool', '-arch', arch, '-l', widgetBinary)
const text = commands.match(/segname __TEXT\s+vmaddr (0x[0-9a-f]+)\s+vmsize \S+\s+fileoff (\d+)/i)
const main = commands.match(/cmd LC_MAIN\s+cmdsize \d+\s+entryoff (\d+)/)
assert.ok(text && main, 'Widget Mach-O needs a __TEXT segment and LC_MAIN')
const entry = BigInt(text[1]) - BigInt(text[2]) + BigInt(main[1])
const symbols = command('xcrun', 'llvm-objdump', '--macho', '--arch=' + arch, '--indirect-symbols', widgetBinary)
const extensionMain = [...symbols.matchAll(/^(0x[0-9a-f]+)\s+\d+\s+_NSExtensionMain$/gmi)]
assert.ok(extensionMain.some(([_, address]) => BigInt(address) === entry), 'Widget must launch via NSExtensionMain')
const bytes = readFileSync(widgetBinary)
for (const kind of ['Widget', 'LatestUpload', 'Sales']) {
  assert.ok(bytes.includes(Buffer.from('dev.creatordashboard.desktop.' + kind)), 'Missing compiled widget kind ' + kind)
}
console.log('Verified three widget kinds, channel picker metadata, sandbox, XPC entry point, app link and native bridge.')
