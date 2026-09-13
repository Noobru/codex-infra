import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ROUTING_CONFIGURATION, RoutingConfigurationSchema, RoutingPolicy } from './routing.js';

/** One configuration source shared by entry, CLI, MCP and TaskEngine. */
export class RoutingConfigurationStore {
  constructor(readonly root: string) {}

  async read(): Promise<RoutingPolicy> {
    let raw: unknown;
    let configurationSource: 'profile-file' | 'built-in-default' = 'profile-file';
    try { raw = JSON.parse(await fs.readFile(path.join(this.root, 'profiles/model-routing.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = DEFAULT_ROUTING_CONFIGURATION;
      configurationSource = 'built-in-default';
    }
    return new RoutingPolicy({ configuration: RoutingConfigurationSchema.parse(raw), configurationSource });
  }
}
