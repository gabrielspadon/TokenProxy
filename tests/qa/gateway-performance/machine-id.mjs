// Match the existing bundler's CommonJS named-export interop in the route arm.
import { createRequire } from 'node:module';
const implementation = createRequire(import.meta.url)('node-machine-id');
export const machineIdSync = implementation.machineIdSync;
export const machineId = implementation.machineId;
