// SPDX-License-Identifier: AGPL-3.0-only
// Fantay workspace barrel (spec 02 §4.1): the W1 seams (board host contract, root-tab helpers, open-request
// routing, share target, board viewport store, workspace bus, design-editor event) and the W2 workspace
// controller + header pieces that FileWorkspace mounts.
export * from './board-host-contract';
export * from './workspace-roots';
export * from './open-request-routing';
export * from './share-target';
export * from './board-viewport-store';
export * from './workspace-bus';
export * from './design-editor-events';
export * from './useFantayWorkspace';
export * from './BoardHeader';
export * from './BoardZoomMenu';
export * from './ShareCta';
export * from './BoardTabHost';
export * from './ProjectDesignSystemTab';
export * from './WorkspaceLoader';
