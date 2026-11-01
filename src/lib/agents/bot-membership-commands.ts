import 'server-only';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { bindBotMemberSession, BotMembershipError, createBotMember, linkBotMemberSource, listBotMembers,
  membershipId, opaqueSourceId, renameBotMember, setBotMemberHome, unbindBotMemberSession } from './bot-membership-store';

/** Internal local-operator seam. It is deliberately absent from HTTP/MCP routing. */
export function applyLocalBotMembershipCommand(input: unknown, sqlite: Database.Database = getSqlite()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BotMembershipError('invalid_command', 'Provide a local membership command object.');
  const command = input as Record<string, unknown>;
  const optional = (value: unknown): string | null | undefined => value === undefined || value === null ? value : opaqueSourceId(value);
  switch (command.action) {
    case 'list': return listBotMembers(sqlite);
    case 'create': return createBotMember({ id: command.id === undefined ? undefined : membershipId(command.id),
      house: opaqueSourceId(command.house), name: opaqueSourceId(command.name),
      iconKey: optional(command.iconKey), homeThreadId: optional(command.homeThreadId) }, sqlite);
    case 'rename': return renameBotMember(membershipId(command.memberId), opaqueSourceId(command.name), sqlite);
    case 'home': return setBotMemberHome(membershipId(command.memberId), command.threadId === null ? null : opaqueSourceId(command.threadId), sqlite);
    case 'bind': return bindBotMemberSession(membershipId(command.memberId), opaqueSourceId(command.agentId), sqlite);
    case 'unbind': return unbindBotMemberSession(membershipId(command.memberId), opaqueSourceId(command.bindingId), sqlite);
    case 'source': return linkBotMemberSource(membershipId(command.memberId), membershipId(command.sourceId), sqlite);
    default: throw new BotMembershipError('invalid_command', 'Use create, rename, home, bind, unbind, source or list.');
  }
}
