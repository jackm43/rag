type Field = string | FieldSet;
type FieldSet = Record<string, Field[] | FieldWithArgs>;

type FieldWithArgs = {
  args: Record<string, string>;
  fields: Field[];
};

const isFieldWithArgs = (value: Field[] | FieldWithArgs): value is FieldWithArgs =>
  !Array.isArray(value);

const renderField = (field: Field): string => {
  if (typeof field === "string") {
    return field;
  }
  return Object.entries(field)
    .map(([name, value]) => {
      if (isFieldWithArgs(value)) {
        const args = Object.entries(value.args)
          .map(([key, arg]) => `${key}: ${arg}`)
          .join(", ");
        return `${name}(${args}) { ${value.fields.map(renderField).join(" ")} }`;
      }
      return `${name} { ${value.map(renderField).join(" ")} }`;
    })
    .join(" ");
};

export const inlineQuery = (fields: FieldSet): string => `{ ${renderField(fields)} }`;

export const operationQuery = (
  operationName: string,
  variableDefs: Record<string, string>,
  fields: FieldSet,
): string => {
  const defs = Object.entries(variableDefs)
    .map(([name, type]) => `$${name}: ${type}`)
    .join(", ");
  return `query ${operationName}(${defs}) { ${renderField(fields)} }`;
};

export const applicationSummaryFields = [
  "name",
  "audience",
  "endpoint",
  "description",
  "provider",
  "trustZone",
  "createdAt",
  "updatedAt",
] as const;

export const applicationDetailFields: Field[] = [
  ...applicationSummaryFields,
  { resources: ["name", { methods: ["name", "scope"] }] },
  { delegations: ["audience", "scopes"] },
];

export const syncStateFields = ["syncedAt", "applications", "delegations", "methods"] as const;

export const applicationsListQuery = inlineQuery({
  applications: [...applicationSummaryFields],
  syncState: [...syncStateFields],
});

export const applicationDetailQuery = operationQuery(
  "ApplicationDetail",
  { name: "String!" },
  {
    application: {
      args: { name: "$name" },
      fields: applicationDetailFields,
    },
  },
);

export const delegationGraphQuery = inlineQuery({
  delegationGraph: ["application", "audience", "scopes"],
  applications: ["name", "audience"],
});

export const registryQuery = inlineQuery({
  applications: applicationDetailFields,
  delegationGraph: ["application", "audience", "scopes"],
});
