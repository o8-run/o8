import { O8dProducer } from '@/lib/ws-server/o8d-producer';
import { bindComposerOwnerProducer } from '@/lib/orchestrator/composer-owner-client';
/** An explicitly designated disposable executor, never a second Next producer. */
export async function attachFixtureComposerExecutor(): Promise<() => void> {
  const socket = process.env.O8D_PRODUCER_SOCKET, key = process.env.O8D_BRIDGE_KEY,
    port = process.env.O8D_PRODUCER_UPSTREAM_PORT, epoch = process.env.O8_COMPOSER_FIXTURE_EPOCH;
  if (!socket || !key || !port || !epoch) throw Error('Native composer executor fixture environment is missing.');
  const producer = new O8dProducer(socket, key, `127.0.0.1:${port}`, epoch, () => undefined);
  await producer.start();
  const unbind = bindComposerOwnerProducer((method, params) => producer.composerRequest(method, params));
  return () => { unbind(); producer.stop(); };
}
