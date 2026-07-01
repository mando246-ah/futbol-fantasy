export const NEWS_LAST_SEEN_STORAGE_KEY = "futbolFantasy:lastSeenNewsPostId";
export const NEWS_SEEN_EVENT = "futbolFantasy:newsSeenChanged";

function newsDateValue(date) {
  const parsed = Date.parse(`${date || ""}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getLatestNewsPost(posts = []) {
  const indexedPosts = (Array.isArray(posts) ? posts : [])
    .filter(Boolean)
    .map((post, index) => ({ post, index }));

  if (!indexedPosts.length) return null;

  indexedPosts.sort((a, b) => {
    const dateDiff = newsDateValue(b.post?.date) - newsDateValue(a.post?.date);
    if (dateDiff) return dateDiff;
    return a.index - b.index;
  });

  return indexedPosts[0].post || null;
}

export function getLatestNewsPostId(posts = []) {
  return String(getLatestNewsPost(posts)?.id || "").trim();
}

export function getLastSeenNewsPostId() {
  if (typeof window === "undefined") return "";

  try {
    return String(window.localStorage.getItem(NEWS_LAST_SEEN_STORAGE_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

export function markNewsPostSeen(postId) {
  const cleanPostId = String(postId || "").trim();
  if (!cleanPostId || typeof window === "undefined") return;

  try {
    window.localStorage.setItem(NEWS_LAST_SEEN_STORAGE_KEY, cleanPostId);
  } catch (_) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(NEWS_SEEN_EVENT, {
      detail: { postId: cleanPostId },
    })
  );
}

export function markLatestNewsPostSeen(posts = []) {
  markNewsPostSeen(getLatestNewsPostId(posts));
}
