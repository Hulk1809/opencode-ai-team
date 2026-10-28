export const roles = ['admin','frontend','backend','devops','qa'] as const;
export type Role = typeof roles[number];
export const columns = ['Backlog','Todo','In Progress','Review','Blocked','Done'] as const;
export type TaskStatus = typeof columns[number];
