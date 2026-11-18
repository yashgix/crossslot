// Only used by room broadcast methods, which these scripts never call.
export const presenceEventName = (type: string) => `${type}:presence`
export const roomName = (room: { type: string; id: string }) => `${room.type}:${room.id}`
