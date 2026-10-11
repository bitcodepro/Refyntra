// Node-only exports for the extension host (child process, file system scan). Never imported by application code.
export * from './host/workerProcess';
export { hasWebProject } from './node/scan';
