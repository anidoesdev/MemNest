// Runs ui-core's force layout off the main thread for graphs above 500 nodes.
import { serveLayoutRequests, type MessagePortLike } from '@memnest/ui-core';

serveLayoutRequests(self as unknown as MessagePortLike);
