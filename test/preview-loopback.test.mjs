import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
for (const args of ["0, '0.0.0.0'", "{ port: 0, host: '0.0.0.0' }"]) {
  test(`Node preview listener is forced to loopback: ${args}`, async () => {
    const { stdout } = await run(process.execPath, ['--require', fileURLToPath(new URL('../src/preview/loopback-only.cjs', import.meta.url)), '-e', `const s=require('node:http').createServer(); s.listen(${args},()=>{console.log(s.address().address);s.close()});`]);
    assert.equal(stdout.trim(), '127.0.0.1');
  });
}
