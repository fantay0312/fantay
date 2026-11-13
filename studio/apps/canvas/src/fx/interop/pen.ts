// SPDX-License-Identifier: Apache-2.0
/** pencil.dev `.pen` → a new design, through the core IO registry's read-only `pen` format (06 §8.4). */
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';

import { BUILTIN_IO_FORMATS, IORegistry, type SceneGraph } from '../engine/op';

export async function penToSceneGraph(fileName: string, bytes: ArrayBuffer): Promise<SceneGraph> {
  try {
    const result = await new IORegistry(BUILTIN_IO_FORMATS).readDocument({ name: fileName, data: new Uint8Array(bytes) });
    return result.graph;
  } catch (error) {
    throw new DesignBridgeFailure('PARSE_FAILED', error instanceof Error ? error.message : String(error));
  }
}
