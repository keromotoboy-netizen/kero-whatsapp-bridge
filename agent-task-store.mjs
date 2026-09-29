import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const now = () => Date.now();
const makeId = prefix => prefix + '_' + crypto.randomBytes(6).toString('hex');

export function createAgentTaskStore(dataDir) {
  const file = path.join(path.dirname(dataDir), 'agent-tasks.json');
  let state = { tasks: [], updatedAt: now() };

  try {
    if (fs.existsSync(file)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch (error) {
    console.error('[agent-tasks] load failed', error?.message || error);
  }

  const save = () => {
    state.updatedAt = now();
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    fs.renameSync(file + '.tmp', file);
  };

  const createTask = ({
    type,
    requester = 'crm_ai',
    specialistAgent,
    contactJid = null,
    serviceId = null,
    inputs = {},
    requiresHuman = true,
    confidence = null,
    customerMessage = null
  }) => {
    const task = {
      id: makeId('task'),
      type,
      requester,
      specialistAgent,
      contactJid,
      serviceId,
      inputs,
      outputs: null,
      status: 'queued',
      requiresHuman: !!requiresHuman,
      confidence,
      customerMessage,
      createdAt: now(),
      updatedAt: now(),
      history: [{ at: now(), status: 'queued', by: requester }]
    };
    state.tasks.push(task);
    save();
    return task;
  };

  const updateTask = (id, patch = {}, by = 'system') => {
    const task = state.tasks.find(x => x.id === id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: now() });
    if (patch.status) task.history.push({ at: now(), status: patch.status, by });
    save();
    return task;
  };

  const listTasks = ({ status = null, specialistAgent = null } = {}) =>
    state.tasks
      .filter(x => !status || x.status === status)
      .filter(x => !specialistAgent || x.specialistAgent === specialistAgent)
      .sort((a,b) => b.createdAt - a.createdAt);

  const getTask = id => state.tasks.find(x => x.id === id) || null;

  return { createTask, updateTask, listTasks, getTask, save };
}

export const SPECIALIST_AGENTS = Object.freeze({
  FINANCE_INVOICE: 'finance_invoice',
  FINANCE_RECEIPT: 'finance_receipt',
  PAYMENT_REVIEW: 'payment_review',
  QUOTE_CALCULATOR: 'quote_calculator',
  ROUTE_PLANNER: 'route_planner',
  COURIER_ALLOCATION: 'courier_allocation',
  CUSTOMER_SUPPORT: 'customer_support'
});
