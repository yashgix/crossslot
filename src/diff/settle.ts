/** Waits for every task to finish, then returns the values or throws the first failure. */
export async function allDone<T>(tasks: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(tasks)
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value)
}
