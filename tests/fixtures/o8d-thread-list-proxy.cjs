// Named exports keep the fixture's ESM and require instrumentation identical.
exports.handleNativeHttp = (...args) => require('../../src/lib/ws-server/native-http-routes.ts').handleNativeHttp(...args);
exports.nativeClientAddr = (...args) => require('../../src/lib/ws-server/native-http-routes.ts').nativeClientAddr(...args);
exports.composeNativeThreadList = (...args) => require('../../src/lib/ws-server/native-thread-list-compose.ts').composeNativeThreadList(...args);
exports.projectAllNetworkThreads = (...args) => require('../../src/lib/bots/network-projection.ts').projectAllNetworkThreads(...args);
exports.projectNetworkThread = (...args) => require('../../src/lib/bots/network-projection.ts').projectNetworkThread(...args);
exports.projectNetworkConversation = (...args) => require('../../src/lib/bots/network-projection.ts').projectNetworkConversation(...args);
exports.localMachineName = (...args) => require('../../src/lib/mobile/machine-name.ts').localMachineName(...args);
exports.readMachineName = (...args) => require('../../src/lib/mobile/machine-name.ts').readMachineName(...args);
exports.readChosenMachineName = (...args) => require('../../src/lib/mobile/machine-name.ts').readChosenMachineName(...args);
