import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'audio-device-state.ps1'), 'utf8');

test('audio device battery reads real Windows PnP properties', () => {
  assert.match(source, /DEVPKEY_Bluetooth_BatteryLevel/);
  assert.match(source, /DEVPKEY_Device_BatteryLevel/);
  assert.match(source, /Get-PnpDeviceProperty\s+-InstanceId/);
  assert.match(source, /Convert-ToBatteryPercent/);
});

test('audio accessory does not infer connection from a remembered Bluetooth device alone', () => {
  assert.doesNotMatch(source, /\$keywordPattern\s*=\s*['"]/);
  assert.match(source, /Get-PnpDevice\s+-Class\s+AudioEndpoint\s+-PresentOnly/);
});
