// 兼容 shim：规则规范来源已移到 memoryd/src/memory-rules.mjs（打包需要自包含）。
// memory-ingest 的规则抽取行为不变；改动规范文件后请跑 memoryd 的 parity 测试。
export * from '../../memoryd/src/memory-rules.mjs';
