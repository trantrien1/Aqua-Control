import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
fs.mkdirSync('.tooling', { recursive: true });
const binary = path.resolve('.tooling', process.platform === 'win32' ? 'water-test.exe' : 'water-test');
const compiler = process.env.CXX || 'g++';
const built = spawnSync(compiler, ['-std=c++14', '-Wall', '-Wextra', 'tests/water-change.test.cpp', '-o', binary], { stdio: 'inherit', windowsHide: true });
if (built.error) { console.error('Cần compiler C++ (g++ hoặc biến CXX).', built.error.message); process.exit(1); }
if (built.status !== 0) process.exit(built.status || 1);
const tested = spawnSync(binary, [], { stdio: 'inherit', windowsHide: true });
process.exit(tested.status ?? 1);
