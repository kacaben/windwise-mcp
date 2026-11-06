/**
 * An error caused by the request itself (bad day, inverted hour range, ...).
 * Its message is written for the model to read and act on, so it is returned
 * verbatim. Any error that is NOT one of the known types is treated as a bug:
 * logged on the server and replaced by a generic message.
 */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}
