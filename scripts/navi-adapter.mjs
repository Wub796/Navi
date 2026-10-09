// Compatibility shim: the adapter now lives in src/adapter.js and ships as dist/index.*.
// Existing scripts import this path, so keep it as a re-export.
export { NaviPlaywrightAdapter, naviAdapter, NAVI_PROTOCOL_VERSION } from '../src/adapter.js';
