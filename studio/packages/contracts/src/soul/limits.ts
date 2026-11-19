// SPDX-License-Identifier: Apache-2.0
/** Every string, array and number bound of the soul layer. Schemas, the importer and the editor counters read this. */
export const SOUL_LIMITS = {
  // character
  name: 60, nickname: 100, tagline: 120, description: 32000, personality: 16000, scenario: 16000,
  firstMessage: 32000, alternateGreetings: 64, alternateGreetingsTotal: 400000, exampleDialogue: 32000,
  systemPrompt: 16000, postHistoryInstructions: 16000, characterNote: 4000, noteDepth: 999, creatorNotes: 32000,
  tags: 64, tag: 60, creator: 200, characterVersion: 100, openers: 4, opener: 60, lorebookIds: 16,
  // state schema and decks
  stateFields: 24, stateLabel: 40, stateHint: 200, stateText: 400, stateOptions: 24, stateOption: 40,
  stateListItems: 40, stateListItem: 80,
  decks: 8, deckCards: 120, deckName: 40, cardTitle: 60, cardText: 600, cardSecret: 600,
  // world book
  loreEntries: 1000, loreContent: 32000, loreContentTotal: 2000000, loreKeys: 64, loreKey: 400, loreTitle: 200,
  loreOrder: 1000000000, loreDepth: 999, loreScanDepth: 1000, loreTimer: 100000, loreGroups: 8, loreGroup: 80,
  loreGroupWeight: 10000, lorebookName: 120, lorebookDescription: 2000,
  loreBudgetMin: 50, loreBudgetMax: 64000, loreBudgetDefault: 4000, loreImportBudgetFloor: 8000,
  loreRegexSource: 200, loreRegexInput: 4000, loreRecursionBuffer: 16000, lorePasses: 5, entryPreserved: 8192,
  // persona, preset
  personaName: 60, personaDescription: 8000,
  presetName: 60, presetDescription: 300, presetMain: 16000, presetPostHistory: 16000, presetExtra: 4000,
  // chat settings and state
  chatLorebookIds: 16, disabledLoreEntries: 5000, authorNote: 4000, chatScenario: 16000,
  userStateOps: 1000, stateOpsPerCall: 16,
  // turns
  messageContent: 32000, variantsPerSlot: 12, speakersPerTurn: 4, pendingCandidates: 12, tracesPerConversation: 5,
  mood: 12, choices: 4, choice: 60, remember: 2, rememberText: 300, playRequests: 2, opsPerReply: 16,
  // foreign data
  preservedJson: 262144, foreignDepth: 24, foreignNodes: 20000, foreignString: 100000, dataUriInline: 2048,
  needsReview: 200,
  // files
  cardTextChars: 16000000, pngCardBase64: 11000000, pngChunks: 100000, assetBytes: 1572864, portraitMaxPx: 1024,
  // stage 2: live text, voice, CHARX, decks
  liveChars: 128000, liveSplitChars: 4000,
  speechChars: 2000, speechPreviewChars: 120, voiceModel: 120, voiceId: 200, voiceLanguage: 20,
  charxBytes: 67108864, charxEntries: 4096, charxNameBytes: 512, charxCardBytes: 16777216,
  charxAssetBytes: 20971520, charxExtractBytes: 100663296, charxReport: 200,
  deckPasteChars: 100000,
} as const;
export type SoulLimits = typeof SOUL_LIMITS;
