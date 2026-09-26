// Discord protocol values stay numeric: runtime enums from discord-api-types
// do not resolve reliably under the Workers bundler.
export type ApplicationCommandOptionJSON = {
  type: 3 | 6;
  name: string;
  description: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
};

export type SlashCommandJSON = {
  name: string;
  description: string;
  options?: ApplicationCommandOptionJSON[];
};

// The registry and registration script consume the same definition.
export const commandData = (name: string, description: string, options: ApplicationCommandOptionJSON[] = []) => ({
  name,
  toJSON: (): SlashCommandJSON => ({ name, description, ...(options.length ? { options } : {}) }),
});
