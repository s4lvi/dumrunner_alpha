// Renamed to /editor/props. The route is preserved so old
// bookmarks / links continue to work, but the page just redirects
// to the new path.

import { redirect } from 'next/navigation';

export default function DecoratorsRedirect() {
  redirect('/editor/props');
}
