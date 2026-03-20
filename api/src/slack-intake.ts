type Announcement = {
  channelId: string;
  threadTs: string;
  userId: string;
  owner: string;
  repo: string;
  issueNumber: number;
};

const ANNOUNCEMENTS = new Map<string, Announcement>();

function key(channelId: string, threadTs: string) {
  return `${channelId}:${threadTs}`;
}

export function recordAnnouncement(announcement: Announcement) {
  ANNOUNCEMENTS.set(
    key(announcement.channelId, announcement.threadTs),
    announcement,
  );
}

export function getAnnouncementForThread(channelId: string, threadTs: string) {
  return ANNOUNCEMENTS.get(key(channelId, threadTs));
}
