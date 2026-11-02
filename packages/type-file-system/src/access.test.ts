import { describe, expect, it } from 'vitest'
import { toMemberKind, toRecordAccessDetails, toViewAccessDetails } from './access.ts'

describe('access details contract', () => {
  it('keeps only contract fields and drops raw rows', () => {
    const details = toRecordAccessDetails({
      private: false, scope: 'shared', ownerId: 'ada',
      people: [{ id: 'bob', name: 'Bob', email: 'bob@x', role: 'viewer', member_kind: 'external', memberKind: 'external', secret: 1 }],
      groups: [{ id: 'g1', name: '', role: 'editor' }],
      memberViews: [{ id: 'builtin-member:member', role: 'viewer' }],
      viewGrants: [{ viewId: 'v', subjectType: 'account', subjectId: 'bob', role: 'viewer', name: 'Bob', email: 'bob@x' }],
      roleChain: [{ id: 'k', title: '这条内容', detail: '你是创建者', role: 'owner' }, { id: 'bad', role: 'superuser' }],
      policy: { owner_account_id: 'ada' },
      grants: [{ subject_id: 'carol', email: 'carol@x', granted_by: 'ada' }],
    })
    expect(details).toEqual({
      private: false, scope: 'shared', ownerId: 'ada',
      people: [{ id: 'bob', name: 'Bob', email: 'bob@x', role: 'viewer', memberKind: 'external' }],
      groups: [{ id: 'g1', name: 'g1', role: 'editor' }],
      memberViews: [{ id: 'builtin-member:member', role: 'viewer' }],
      viewGrants: [{ viewId: 'v', subjectType: 'account', subjectId: 'bob', role: 'viewer', name: 'Bob', email: 'bob@x', grantedBy: '', memberKind: 'member' }],
      roleChain: [{ id: 'k', title: '这条内容', detail: '你是创建者', role: 'owner' }],
    })
  })

  it('fills missing fields so both storage paths have the same shape', () => {
    expect(toRecordAccessDetails({ scope: 'weird', ownerId: 'ada', people: [{ id: 'ada', role: 'owner' }] })).toMatchObject({
      private: true, scope: 'personal', groups: [], memberViews: [], viewGrants: [], roleChain: [],
    })
    expect(toViewAccessDetails({ people: [], memberViews: [{ id: 'm', role: 'viewer' }], grants: [{}] }, 'v1')).toEqual({
      private: false, scope: 'personal', ownerId: '', viewId: 'v1', people: [], groups: [], memberViews: [{ id: 'm', role: 'viewer' }],
    })
  })

  it('normalizes member kinds', () => {
    expect(['external', 'guest', 'member', '', null, 'admin'].map(toMemberKind)).toEqual(['external', 'guest', 'member', 'member', 'member', 'member'])
  })
})
