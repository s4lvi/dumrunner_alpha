// Default editor landing — redirects to the textures editor.
// Anyone hitting /editor lands somewhere immediately useful;
// the actual top-nav lives in editor/layout.tsx.

import { redirect } from 'next/navigation';

export default function EditorIndex() {
  redirect('/editor/textures');
}
