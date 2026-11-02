/** A count's noun or verb, including irregular plurals. */
export function plural(count: number, singular: string, multiple = `${singular}s`) {
  return count === 1 ? singular : multiple;
}
