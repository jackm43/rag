// A minimal, Workers-safe slash-command builder.
//
// Why not @discordjs/builders: that package reads discord-api-types' runtime
// enums at module-load time (s.nativeEnum(ChannelType) etc.). Under the Workers
// runtime (workerd, both wrangler and the vitest pool) those enums resolve to
// `undefined` — the same discord-api-types CJS/ESM interop bug documented in
// src/index.ts — so merely importing @discordjs/builders throws
// "Cannot convert undefined or null to object" before any command runs.
// Confirmed: even forcing the ESM builds of both packages, the enums are still
// undefined at import. So we cannot construct SlashCommandBuilder in the worker.
//
// This builder covers exactly the fluent surface the ten commands use, keeps
// `.name` for registry keying, and emits the Discord application-command JSON
// via toJSON() for the (Node-run) registration script. The evobot-style
// `data: new SlashCommandBuilder().setName(...)...` shape is unchanged.

// discord-api-types ApplicationCommandOptionType values (numeric to avoid the
// runtime-enum interop issue): STRING = 3, USER = 6.
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_USER = 6;

export type ApplicationCommandOptionJSON = {
  type: number;
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

abstract class SlashCommandOptionBuilder {
  protected optionName = "";
  protected optionDescription = "";
  protected optionRequired = false;

  abstract readonly type: number;

  setName(name: string): this {
    this.optionName = name;
    return this;
  }

  setDescription(description: string): this {
    this.optionDescription = description;
    return this;
  }

  setRequired(required: boolean): this {
    this.optionRequired = required;
    return this;
  }

  toJSON(): ApplicationCommandOptionJSON {
    return {
      type: this.type,
      name: this.optionName,
      description: this.optionDescription,
      required: this.optionRequired,
    };
  }
}

export class SlashCommandUserOption extends SlashCommandOptionBuilder {
  readonly type = OPTION_TYPE_USER;
}

export class SlashCommandStringOption extends SlashCommandOptionBuilder {
  readonly type = OPTION_TYPE_STRING;
  private optionMinLength?: number;
  private optionMaxLength?: number;

  setMinLength(minLength: number): this {
    this.optionMinLength = minLength;
    return this;
  }

  setMaxLength(maxLength: number): this {
    this.optionMaxLength = maxLength;
    return this;
  }

  override toJSON(): ApplicationCommandOptionJSON {
    return {
      ...super.toJSON(),
      ...(this.optionMinLength !== undefined ? { min_length: this.optionMinLength } : {}),
      ...(this.optionMaxLength !== undefined ? { max_length: this.optionMaxLength } : {}),
    };
  }
}

export class SlashCommandBuilder {
  name = "";
  description = "";
  private readonly options: SlashCommandOptionBuilder[] = [];

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDescription(description: string): this {
    this.description = description;
    return this;
  }

  addUserOption(configure: (option: SlashCommandUserOption) => SlashCommandUserOption): this {
    this.options.push(configure(new SlashCommandUserOption()));
    return this;
  }

  addStringOption(configure: (option: SlashCommandStringOption) => SlashCommandStringOption): this {
    this.options.push(configure(new SlashCommandStringOption()));
    return this;
  }

  toJSON(): SlashCommandJSON {
    return {
      name: this.name,
      description: this.description,
      ...(this.options.length > 0 ? { options: this.options.map((option) => option.toJSON()) } : {}),
    };
  }
}
