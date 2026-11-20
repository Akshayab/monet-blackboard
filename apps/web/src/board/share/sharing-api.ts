// Client types + helpers for the sharing API (apps/server/src/routes/sharing.ts).
import { api } from '@/lib/api';
import type { BoardRole } from '@/lib/api';

export type LinkAccess = 'none' | 'view' | 'edit';

export interface SharingPerson {
  userId: string;
  name: string;
}

export interface SharingMember extends SharingPerson {
  role: BoardRole;
  source: 'link' | 'direct';
  lastOpenedAt: string | null;
}

export interface SharingState {
  teamMode: boolean;
  board: { id: string; title: string; linkAccess: LinkAccess; linkToken: string | null };
  me: { userId: string; role: BoardRole; via: 'owner' | 'member' | 'link' };
  permissions: { canManage: boolean; canChangeLink: boolean };
  owner: SharingPerson | null;
  members: SharingMember[];
}

export function shareLinkUrl(token: string) {
  return `${window.location.origin}/s/${token}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/iframes without clipboard permission.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export const sharingApi = {
  get: (boardId: string, linkToken: string | null) => api<SharingState>(`/boards/${boardId}/sharing`, { linkToken }),
  setMemberRole: (boardId: string, userId: string, role: 'editor' | 'commenter' | 'viewer') =>
    api(`/boards/${boardId}/members/${userId}`, { method: 'PATCH', json: { role } }),
  removeMember: (boardId: string, userId: string, linkToken: string | null) => api(`/boards/${boardId}/members/${userId}`, { method: 'DELETE', linkToken }),
  setLink: (boardId: string, access: LinkAccess) =>
    api<{ linkAccess: LinkAccess; linkToken: string }>(`/boards/${boardId}/link`, { method: 'PATCH', json: { access } }),
  regenerateLink: (boardId: string) => api<{ linkAccess: LinkAccess; linkToken: string }>(`/boards/${boardId}/link/regenerate`, { method: 'POST' }),
};
