// Attachment registry boot. Reads
// packages/shared/content/attachments/<id>.json at server boot
// and pushes the entries into the shared ATTACHMENT_DEFS +
// ATTACHMENT_STAT_RANGES tables via setAttachmentRegistry.
// The disk format folds def + rolls into one shape; the setter
// splits them. Mirrors recipes.ts / weapons.ts.

import { loadAttachments } from '@dumrunner/shared/content/loader';
import {
  setAttachmentRegistry,
  type AttachmentDef,
  type AttachmentStatRanges,
} from '@dumrunner/shared';

type AttachmentWireEntry = AttachmentDef & { rolls?: AttachmentStatRanges };
let ATTACHMENTS_WIRE: AttachmentWireEntry[] = [];

export async function initAttachments(): Promise<void> {
  // AttachmentDefData (disk) is structurally identical to
  // AttachmentDef + optional `rolls`. Cast through unknown to
  // acknowledge the structural-only match.
  const defs = (await loadAttachments()) as unknown as AttachmentWireEntry[];
  if (defs.length === 0) {
    console.warn(
      '[attachments] no attachment JSON files found in shared/content/attachments — weapons will assemble bare with no mod / affix options',
    );
  } else {
    const mods = defs.filter((d) => d.kind === 'weapon_mod').length;
    const wAff = defs.filter((d) => d.kind === 'weapon_affix').length;
    const sAff = defs.filter((d) => d.kind === 'suit_affix').length;
    console.log(
      `[attachments] loaded ${defs.length} (${mods} mods, ${wAff} weapon affixes, ${sAff} suit affixes)`,
    );
  }
  ATTACHMENTS_WIRE = defs;
  setAttachmentRegistry(defs);
}

// Subset shipped to the client in the welcome message. Same shape
// as the disk JSON — clients call setAttachmentRegistry on receive.
export function getAttachmentsForWire(): AttachmentWireEntry[] {
  return ATTACHMENTS_WIRE;
}
