// SPDX-License-Identifier: AGPL-3.0-only
// Face registry for the file-backed and generated kinds (spec 03 §4.1–§4.5, §4.9–§4.11; plan R4/R5): `NodeShell`
// renders `BOARD_NODE_FACES[kind]` for frame, web, image, video, audio, generator, design and motion (note, shape and
// group faces belong to the engine core). Faces receive `{ view: NodeView }` and read the rest through the board
// contexts; the generation, design and motion extensions (plan §3.2) are dispatched from inside these faces, which
// fall back to minimal faces when an extension is absent.
//
// NodeShell already renders the positioned wrapper, the pointer shield (only while live and no mode lifts it), the
// LOD rect, the label, `MissingFace` and `PendingFace`; a face draws only the node's own content.
import type { ComponentType } from 'react';

import type { BoardNodeKind, NodeFaceProps } from '../model/types';
import { DesignNode } from './design/DesignNode';
import { FrameNode } from './frame/FrameNode';
import { GeneratorNode } from './generator/GeneratorNode';
import { AudioNode } from './media/AudioNode';
import { ImageNode } from './media/ImageNode';
import { VideoNode } from './media/VideoNode';
import { MotionNode } from './motion/MotionNode';
import { WebNode } from './web/WebNode';

export type NodeFaceComponent = ComponentType<NodeFaceProps>;

export type FileNodeKind = Exclude<BoardNodeKind, 'note' | 'shape' | 'group'>;

export const BOARD_NODE_FACES: Readonly<Partial<Record<FileNodeKind, NodeFaceComponent>>> = {
  frame: FrameNode,
  web: WebNode,
  image: ImageNode,
  video: VideoNode,
  audio: AudioNode,
  generator: GeneratorNode,
  design: DesignNode,
  motion: MotionNode,
};
