import { randomUUID } from 'node:crypto'
import { client } from './feishu'

export async function fetchChatOwnerOpenId(chatId: string): Promise<string> {
  const res = await callFeishuApi('feishu chat.get', () => client.im.chat.get({
    path: { chat_id: chatId },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) {
    throwFeishuApiError('feishu chat.get', res)
  }
  const ownerOpenId = res.data?.owner_id
  if (!ownerOpenId) {
    throw new Error('feishu chat.get returned no owner_id; cannot add project group owner to tasklist')
  }
  return ownerOpenId
}

export interface CreatedTasklist {
  guid: string
  name: string
  url: string
  createdAt?: string
}

export async function createTasklistWithOwner(name: string, ownerOpenId: string): Promise<CreatedTasklist> {
  const res = await callFeishuApi('feishu tasklist.create', () => client.task.v2.tasklist.create({
    params: { user_id_type: 'open_id' },
    data: {
      name,
      members: [{ id: ownerOpenId, type: 'user', role: 'editor' }],
    },
  }))
  if (res.code && res.code !== 0) {
    throwFeishuApiError('feishu tasklist.create', res)
  }
  const tasklist = res.data?.tasklist
  const guid = tasklist?.guid
  if (!guid) throw new Error('feishu tasklist.create returned no guid')
  return {
    guid,
    name: tasklist?.name || name,
    url: tasklist?.url ?? '',
    createdAt: tasklist?.created_at,
  }
}

export async function deleteTasklistByGuid(guid: string): Promise<void> {
  const res = await callFeishuApi('feishu tasklist.delete', () => client.task.v2.tasklist.delete({
    path: { tasklist_guid: guid },
  }))
  if (res.code && res.code !== 0) {
    throwFeishuApiError('feishu tasklist.delete', res)
  }
}

export interface TasklistSection {
  guid: string
  name: string
  isDefault?: boolean
  tasklistGuid?: string
}

export interface TaskSummary {
  guid: string
  summary: string
  completedAt?: string
  subtaskCount?: number
}

export interface TaskComment {
  id: string
  content: string
  createdAt?: string
  updatedAt?: string
  creator?: unknown
}

export async function listTasklistSections(tasklistGuid: string): Promise<TasklistSection[]> {
  const out: TasklistSection[] = []
  let pageToken: string | undefined
  do {
    const res = await callFeishuApi('feishu section.list', () => client.task.v2.section.list({
      params: {
        resource_type: 'tasklist',
        resource_id: tasklistGuid,
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    if (res.code && res.code !== 0) throwFeishuApiError('feishu section.list', res)
    for (const item of res.data?.items ?? []) {
      if (!item.guid || !item.name) continue
      out.push({ guid: item.guid, name: item.name, isDefault: item.is_default })
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined
  } while (pageToken)
  return out
}

export async function createTasklistSection(opts: {
  tasklistGuid: string
  name: string
  insertAfter?: string
}): Promise<string> {
  const res = await callFeishuApi('feishu section.create', () => client.task.v2.section.create({
    data: {
      resource_type: 'tasklist',
      resource_id: opts.tasklistGuid,
      name: opts.name,
      ...(opts.insertAfter ? { insert_after: opts.insertAfter } : {}),
    },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu section.create', res)
  const guid = res.data?.section?.guid
  if (!guid) throw new Error(`feishu section.create returned no guid for "${opts.name}"`)
  return guid
}

export async function getTasklistSection(sectionGuid: string): Promise<TasklistSection> {
  const res = await callFeishuApi('feishu section.get', () => client.task.v2.section.get({
    path: { section_guid: sectionGuid },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu section.get', res)
  const section = res.data?.section
  if (!section?.guid) throw new Error(`feishu section.get returned no section: ${sectionGuid}`)
  return {
    guid: section.guid,
    name: section.name ?? '',
    isDefault: section.is_default,
    tasklistGuid: section.tasklist?.guid,
  }
}

export async function patchTasklistSectionName(sectionGuid: string, name: string): Promise<TasklistSection> {
  const res = await callFeishuApi('feishu section.patch', () => client.task.v2.section.patch({
    path: { section_guid: sectionGuid },
    params: { user_id_type: 'open_id' },
    data: {
      section: { name },
      update_fields: ['name'],
    },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu section.patch', res)
  const section = res.data?.section
  if (!section?.guid) throw new Error(`feishu section.patch returned no section: ${sectionGuid}`)
  return {
    guid: section.guid,
    name: section.name ?? '',
    isDefault: section.is_default,
    tasklistGuid: section.tasklist?.guid,
  }
}

export async function deleteTasklistSection(sectionGuid: string): Promise<void> {
  const res = await callFeishuApi('feishu section.delete', () => client.task.v2.section.delete({
    path: { section_guid: sectionGuid },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu section.delete', res)
}

export async function listSectionTasks(sectionGuid: string, completed?: boolean): Promise<TaskSummary[]> {
  const out: TaskSummary[] = []
  let pageToken: string | undefined
  do {
    const res = await callFeishuApi('feishu section.tasks', () => client.task.v2.section.tasks({
      path: { section_guid: sectionGuid },
      params: {
        page_size: 50,
        ...(typeof completed === 'boolean' ? { completed } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    if (res.code && res.code !== 0) throwFeishuApiError('feishu section.tasks', res)
    for (const item of res.data?.items ?? []) {
      if (!item.guid) continue
      out.push({
        guid: item.guid,
        summary: item.summary ?? '',
        completedAt: item.completed_at,
        subtaskCount: item.subtask_count,
      })
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined
  } while (pageToken)
  return out
}

export async function listTasklistTasks(tasklistGuid: string, completed?: boolean): Promise<TaskSummary[]> {
  const out: TaskSummary[] = []
  let pageToken: string | undefined
  do {
    const res = await callFeishuApi('feishu tasklist.tasks', () => client.task.v2.tasklist.tasks({
      path: { tasklist_guid: tasklistGuid },
      params: {
        page_size: 50,
        user_id_type: 'open_id',
        ...(typeof completed === 'boolean' ? { completed } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    if (res.code && res.code !== 0) throwFeishuApiError('feishu tasklist.tasks', res)
    for (const item of res.data?.items ?? []) {
      if (!item.guid) continue
      out.push({
        guid: item.guid,
        summary: item.summary ?? '',
        completedAt: item.completed_at,
        subtaskCount: item.subtask_count,
      })
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined
  } while (pageToken)
  return out
}

export async function discoverTasklistDefaultSectionGuid(tasklistGuid: string): Promise<string> {
  const summary = `lodestar-default-section-discovery-${Date.now()}-${randomUUID().slice(0, 8)}`
  let taskGuid = ''
  try {
    const res = await callFeishuApi('feishu task.create', () => client.task.v2.task.create({
      params: { user_id_type: 'open_id' },
      data: {
        summary,
        tasklists: [{ tasklist_guid: tasklistGuid }],
      },
    }))
    if (res.code && res.code !== 0) throwFeishuApiError('feishu task.create', res)
    const task = res.data?.task
    taskGuid = task?.guid ?? ''
    if (!task || !taskGuid) throw new Error('feishu task.create returned no guid during default section discovery')
    const sectionGuid = task.tasklists
      ?.find(item => item.tasklist_guid === tasklistGuid)
      ?.section_guid
    if (sectionGuid) return sectionGuid

    const full = await getTask(taskGuid)
    const discovered = full.tasklists
      ?.find((item: any) => item.tasklist_guid === tasklistGuid)
      ?.section_guid
    if (!discovered) throw new Error(`failed to discover default section guid for tasklist ${tasklistGuid}`)
    return discovered
  } finally {
    if (taskGuid) await deleteTaskByGuid(taskGuid)
  }
}

export async function deleteTaskByGuid(taskGuid: string): Promise<void> {
  const res = await callFeishuApi('feishu task.delete', () => client.task.v2.task.delete({
    path: { task_guid: taskGuid },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu task.delete', res)
}

export async function getTask(taskGuid: string): Promise<any> {
  const res = await callFeishuApi('feishu task.get', () => client.task.v2.task.get({
    path: { task_guid: taskGuid },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu task.get', res)
  const task = res.data?.task
  if (!task) throw new Error(`feishu task.get returned no task: ${taskGuid}`)
  return task
}

export async function listTaskComments(taskGuid: string): Promise<TaskComment[]> {
  const out: TaskComment[] = []
  let pageToken: string | undefined
  do {
    const res = await callFeishuApi('feishu comment.list', () => client.task.v2.comment.list({
      params: {
        resource_type: 'task',
        resource_id: taskGuid,
        direction: 'asc',
        page_size: 50,
        user_id_type: 'open_id',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    if (res.code && res.code !== 0) throwFeishuApiError('feishu comment.list', res)
    for (const item of res.data?.items ?? []) {
      if (!item.id) continue
      out.push({
        id: item.id,
        content: item.content ?? '',
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        creator: item.creator,
      })
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined
  } while (pageToken)
  return out
}

export async function addTaskComment(taskGuid: string, content: string): Promise<string> {
  const res = await callFeishuApi('feishu comment.create', () => client.task.v2.comment.create({
    data: {
      resource_type: 'task',
      resource_id: taskGuid,
      content,
    },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu comment.create', res)
  const id = res.data?.comment?.id
  if (!id) throw new Error(`feishu comment.create returned no id for task ${taskGuid}`)
  return id
}

export async function moveTaskToSection(taskGuid: string, tasklistGuid: string, sectionGuid: string): Promise<void> {
  const res = await callFeishuApi('feishu task.addTasklist', () => client.task.v2.task.addTasklist({
    path: { task_guid: taskGuid },
    data: { tasklist_guid: tasklistGuid, section_guid: sectionGuid },
    params: { user_id_type: 'open_id' },
  }))
  if (res.code && res.code !== 0) throwFeishuApiError('feishu task.addTasklist', res)
}

export function formatFeishuApiError(api: string, raw: unknown): string {
  const data = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const responseData = data.response?.data && typeof data.response.data === 'object'
    ? data.response.data as Record<string, any>
    : data.data && typeof data.data === 'object'
      ? data.data as Record<string, any>
      : data
  const code = responseData.code ?? data.code
  const msg = responseData.msg ?? responseData.message ?? data.msg ?? data.message ?? 'unknown error'
  const violations = responseData.error?.permission_violations
    ?? responseData.permission_violations
    ?? data.error?.permission_violations
  const scopes = Array.isArray(violations)
    ? violations
        .map((v: any) => v?.scope ?? v?.subject ?? v?.name ?? v)
        .filter(Boolean)
        .join(', ')
    : ''
  return `${api} failed code=${code ?? 'unknown'} msg=${msg}${scopes ? ` missing_scopes=${scopes}` : ''}`
}

async function callFeishuApi<T>(api: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throwFeishuApiError(api, e)
  }
}

function throwFeishuApiError(api: string, raw: unknown): never {
  throw new Error(formatFeishuApiError(api, raw))
}
