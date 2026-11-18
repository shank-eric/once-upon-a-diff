/*
 * The events in <home>/agents.jsonl, read once and then only as far as the file has grown (adapters' `tailLog`: it starts
 * over on a replaced, shortened or refilled file, and takes a half-written last line again when it is finished).
 */
import { tailLog } from '@once-upon-a-diff/adapters/stores/fs/tail-log';
import { parseAgentEvents } from './events.ts';

/** The events in the file, oldest first (none when there is no file). A fresh array each call, over events kept from the last. */
export const agentEventsIn = tailLog(parseAgentEvents);
