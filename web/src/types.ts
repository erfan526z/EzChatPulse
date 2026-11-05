export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  createdAt: number;
  online: boolean;
  lastSeenAt: number | null;
  /** private — only present on /api/me responses (never in member/search DTOs) */
  email?: string | null;
  emailVerified?: boolean;
}

export interface MemberInfo {
  userId: number;
  username: string;
  displayName: string;
  role: 'member' | 'admin';
  online: boolean;
  lastSeenAt: number | null;
}

export interface FileDTO {
  id: number;
  name: string;
  mime: string;
  size: number;
  url: string;
  /** bubble-sized version (present for image types) */
  thumbUrl?: string;
}

export interface MessageDTO {
  id: number;
  chatId: number;
  senderId: number;
  kind: 'text' | 'image' | 'file';
  text: string | null;
  file: FileDTO | null;
  replyTo: number | null;
  createdAt: number;
  editedAt?: number | null;
  deletedAt?: number | null;
}

export interface ChatSummary {
  id: number;
  type: 'private' | 'group';
  name: string | null;
  createdAt: number;
  members: MemberInfo[];
}

export interface ChatDTO extends ChatSummary {
  lastMessage: MessageDTO | null;
  unread: number;
  /** userId → highest message id they've read (others, from the server). */
  readBy?: { userId: number; msgId: number }[];
}

/** Client-side message: optimistic sends carry tempId/pending/failed. */
export interface UIMessage extends MessageDTO {
  tempId?: string;
  pending?: boolean;
  failed?: boolean;
  /** bumped on every server-driven mutation (edit/delete) so the DOM can rebuild */
  rev?: number;
}

export interface UIChat extends Omit<ChatDTO, 'readBy'> {
  messages: UIMessage[];
  hasMore: boolean;
  loadingHistory: boolean;
  /** userId → expiry timestamp of their typing indicator */
  typingUsers: Map<number, number>;
  /** userId → highest message id they've read */
  readBy: Map<number, number>;
}

export interface Session {
  token: string;
  user: UserDTO;
}
