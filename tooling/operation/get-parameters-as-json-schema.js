// This library is built to translate OpenAPI schemas into schemas compatible with react-jsonschema-form, and should
// not at this time be used for general purpose consumption.
const getSchema = require('../lib/get-schema');
const findSchemaDefinition = require('../lib/find-schema-definition');
// const toJsonSchema = require('@openapi-contrib/openapi-schema-to-json-schema');

console.logx = obj => {
  console.log(require('util').inspect(obj, false, null, true /* enable colors */))
}

// The order of this object determines how they will be sorted in the compiled JSON Schema
// representation.
// https://github.com/OAI/OpenAPI-Specification/blob/master/versions/3.0.0.md#parameterObject
const types = {
  path: 'Path Params',
  query: 'Query Params',
  body: 'Body Params',
  cookie: 'Cookie Params',
  formData: 'Form Data',
  header: 'Headers',
};

function isPrimitive(val) {
  return typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean';
}

function getBodyParam(operation, oas) {
  const schema = getSchema(operation, oas);
  if (!schema) return null;

  const cleanupSchemaDefaults = (originType, obj, prevProp = false, prevProps = []) => {
    Object.keys(obj).forEach(prop => {
      // Since this method is recursive, let's reset our states when we're first processing a new property tree.
      if (!prevProp) {
        prevProps = [];
      }

      if (obj[prop] === null) {
        // If the item is null, just carry on. Why do this in addition to `typeof obj[prop] == object`? Because
        // `typeof null` equates to `object` for "legacy reasons" apparently.
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null
      } else if (typeof obj[prop] === 'object' && !Array.isArray(obj[prop])) {
        // If we have a `properties` object, but no adjacent `type`, we know it's an object so just cast it as one.
        if (prop === 'properties' && !('type' in obj)) {
          if (prevProp && prevProp === 'properties') {
            // Only add a type if the previous prop isn't also named `properties`!
          } else {
            obj.type = 'object';
          }
        }

        prevProps.push(prop);
        cleanupSchemaDefaults(originType, obj[prop], prop, prevProps);
      } else {
        if (
          prevProps.includes('properties') &&
          !('type' in obj) &&
          !('$ref' in obj) &&
          !('allOf' in obj) &&
          !('oneOf' in obj) &&
          !('anyOf' in obj) &&
          prevProp !== 'additionalProperties'
        ) {
          // If we're processing a schema that has no types, no refs, and is just a lone schema, we should treat it at
          // the bare minimum as a simple string so we make an attempt to generate valid JSON Schema.
          obj.type = 'string';
        }

        switch (prop) {
          case 'allOf':
          case 'anyOf':
          case 'oneOf':
            // This is a hack in order to fix a bug with RJSF where if a `title` property is stored inside of a `$ref`
            // on a polymorphism schema, that title isn't utilized when constructing an option dropdown for the
            // available elements in said schema.
            //
            // This isn't a bulletproof fix, and honestly dereferencing the schema is a better solution, but until we're
            // able to do that across all of our tooling this will have to do.
            //
            // https://github.com/rjsf-team/react-jsonschema-form/issues/2016
            if (Array.isArray(obj[prop])) {
              obj[prop].forEach((arr, i) => {
                if (!('title' in arr) && '$ref' in arr) {
                  const ref = findSchemaDefinition(arr.$ref, oas);
                  if ('title' in ref) {
                    obj[prop][i].title = ref.title;
                  }
                }
              });
            }
            break;

          case 'additionalProperties':
            // If it's set to `false`, don't bother adding it.
            if (obj[prop] === false) {
              delete obj[prop];
            }
            break;

          case 'default':
            if ('allowEmptyValue' in obj && obj.allowEmptyValue && obj[prop] === '') {
              // If we have `allowEmptyValue` present, and the default is actually an empty string, let it through as
              // it's allowed.
            } else if (obj[prop] === '') {
              delete obj[prop];
            }
            break;

          case 'type':
            if (obj.type === 'array') {
              if (!('items' in obj)) {
                if ('properties' in obj) {
                  // This is a fix to handle cases where someone may have typod `items` as `properties` on an array.
                  // Since throwing a complete failure isn't ideal, we can see that they meant for the type to be
                  // `object`, so we  can do our best to shape the data into what they were intendint it to be.
                  // README-6R
                  obj.type = 'object';
                } else {
                  // This is a fix to handle cases where we have a malformed array with no `items` property present.
                  // README-8E
                  obj.items = {};
                }
              }
            }
            break;

          // Do nothing
          default:
        }
      }
    });

    return obj;
  };

  const type = schema.type === 'application/x-www-form-urlencoded' ? 'formData' : 'body';
  let cleanedSchema;

  if (oas.components) {
    cleanedSchema = {
      components: {},
      ...cleanupSchemaDefaults(null, schema.schema),
    };

    // Since cleanupSchemaDefaults is a recursive method, it's best if we start it at the `components.schemas` level
    // so we have immediate knowledge of when we're first processing a component schema, and can reset our internal
    // prop states that keep track of how we should treat certain prop edge cases.
    Object.keys(oas.components).forEach(componentType => {
      cleanedSchema.components[componentType] = cleanupSchemaDefaults(componentType, oas.components[componentType]);
    });
  } else {
    cleanedSchema = cleanupSchemaDefaults(null, schema.schema);
  }

  // If there's not actually any data within this schema, don't bother returning it.
  if (Object.keys(cleanedSchema).length === 0) {
    return null;
  }

  return {
    type,
    label: types[type],
    schema: cleanedSchema,
  };
}

function getCommonParams(path, oas) {
  if (oas && 'paths' in oas && path in oas.paths && 'parameters' in oas.paths[path]) {
    return oas.paths[path].parameters;
  }

  return [];
}

function getOtherParams(path, operation, oas) {
  let operationParams = operation.parameters || [];
  const commonParams = getCommonParams(path, oas);

  if (commonParams.length !== 0) {
    const commonParamsNotInParams = commonParams.filter(param => {
      return !operationParams.find(param2 => {
        if (param.name && param2.name) {
          return param.name === param2.name && param.in === param2.in;
        } else if (param.$ref && param2.$ref) {
          return param.$ref === param2.$ref;
        }

        return false;
      });
    });

    operationParams = operationParams.concat(commonParamsNotInParams || []);
  }

  const resolvedParameters = operationParams.map(param => {
    if (param.$ref) return findSchemaDefinition(param.$ref, oas);
    return param;
  });

  const constructSchema = (data, prevProp = false) => {
    const schema = {};

    if (data.$ref) {
      data = findSchemaDefinition(data.$ref, oas);
    }

    if (
      !('type' in data) &&
      !('$ref' in data) &&
      !('allOf' in data) &&
      !('anyOf' in data) &&
      !('oneOf' in data) &&
      (!prevProp || (prevProp && prevProp !== 'additionalProperties'))
    ) {
      // If we're processing a schema that has no types, no refs, and is just a lone schema, we should treat it at the
      // bare minimum as a simple string so we make an attempt to generate valid JSON Schema.
      schema.type = 'string';
    } else if (data.type === 'array') {
      schema.type = 'array';

      if ('items' in data) {
        if (Object.keys(data.items).length === 1 && typeof data.items.$ref !== 'undefined') {
          schema.items = findSchemaDefinition(data.items.$ref, oas);
        } else {
          schema.items = data.items;
        }

        // Run through the arrays contents and clean them up.
        schema.items = constructSchema(schema.items);
      } else if ('properties' in data || 'additionalProperties' in data) {
        // This is a fix to handle cases where someone may have typod `items` as `properties` on an array. Since
        // throwing a complete failure isn't ideal, we can see that they meant for the type to be `object`, so we can do
        // our best to shape the data into what they were intending it to be.
        // README-6R
        schema.type = 'object';
      } else {
        // This is a fix to handle cases where we have a malformed array with no `items` property present.
        // README-8E
        schema.items = {};
      }
    } else if (data.type === 'object') {
      schema.type = 'object';

      if ('properties' in data) {
        schema.properties = {};

        Object.keys(data.properties).map(prop => {
          schema.properties[prop] = constructSchema(data.properties[prop], prop);
          return true;
        });
      }

      if ('additionalProperties' in data) {
        if (typeof data.additionalProperties === 'object' && data.additionalProperties !== null) {
          schema.additionalProperties = constructSchema(data.additionalProperties, 'additionalProperties');
        } else if (data.additionalProperties !== false) {
          // If it's set to `false`, don't bother adding it.
          schema.additionalProperties = data.additionalProperties;
        }
      }
    } else if ('type' in data) {
      schema.type = data.type;
    } else {
      // If we don't have a set type, but are dealing with an anyOf, oneOf, or allOf representation let's run through
      // them and make sure they're good.
      // eslint-disable-next-line no-lonely-if
      if ('allOf' in data && Array.isArray(data.allOf)) {
        schema.allOf = data.allOf;
        schema.allOf.forEach((item, idx) => {
          schema.allOf[idx] = constructSchema(item);
        });
      } else if ('anyOf' in data && Array.isArray(data.anyOf)) {
        schema.anyOf = data.anyOf;
        schema.anyOf.forEach((item, idx) => {
          schema.anyOf[idx] = constructSchema(item);
        });
      } else if ('oneOf' in data && Array.isArray(data.oneOf)) {
        schema.oneOf = data.oneOf;
        schema.oneOf.forEach((item, idx) => {
          schema.oneOf[idx] = constructSchema(item);
        });
      }
    }

    if ('allowEmptyValue' in data) schema.allowEmptyValue = data.allowEmptyValue;
    if ('description' in data) schema.description = data.description;
    if ('enum' in data) schema.enum = data.enum;
    if ('format' in data) schema.format = data.format;
    if ('maxLength' in data) schema.maxLength = data.maxLength;
    if ('minLength' in data) schema.minLength = data.minLength;

    // Only add a default value if we actually have one.
    if (typeof data.default !== 'undefined') {
      if ('allowEmptyValue' in schema && schema.allowEmptyValue && data.default === '') {
        // If we have `allowEmptyValue` present, and the default is actually an empty string, let it through as it's
        // allowed.
        schema.default = data.default;
      } else if (data.default !== '') {
        schema.default = data.default;
      }
    }

    if ('example' in data) {
      // Only bother adding primitive examples.
      if (isPrimitive(data.example)) {
        schema.examples = [data.example];
      } else if (Array.isArray(data.example) && isPrimitive(data.example[0])) {
        schema.examples = [data.example[0]];
      }
    } else if ('examples' in data) {
      if (typeof data.examples === 'object' && !Array.isArray(data.examples)) {
        let example = data.examples[Object.keys(data.examples).shift()];
        if ('$ref' in example) {
          example = findSchemaDefinition(example.$ref, oas);
        }

        if ('value' in example) {
          if (isPrimitive(example.value)) {
            schema.examples = [example.value];
          } else if (Array.isArray(example.value) && isPrimitive(example.value[0])) {
            schema.examples = [example.value[0]];
          }
        }
      }
    }

    return schema;
  };

  return Object.keys(types).map(type => {
    const required = [];

    const parameters = resolvedParameters.filter(param => param.in === type);
    if (parameters.length === 0) {
      return null;
    }

    const properties = parameters.reduce((prev, current) => {
      const schema = {
        ...(current.schema ? constructSchema(current.schema) : {}),
      };

      // If we still don't have a `type` at the highest level of this schema, and it's not a polymorphism/inheritance
      // model, add a `string` type so the schema will be valid.
      if (!('type' in schema) && !('allOf' in schema) && !('anyOf' in schema) && !('oneOf' in schema)) {
        schema.type = 'string';
      }

      if (current.description) {
        schema.description = current.description;
      }

      prev[current.name] = schema;

      if (current.required) {
        required.push(current.name);
      }

      return prev;
    }, {});

    return {
      type,
      label: types[type],
      schema: {
        type: 'object',
        properties,
        required,
      },
    };
  });
}

module.exports = (path, operation, oas) => {
  const hasRequestBody = !!operation.requestBody;
  const hasParameters = !!(operation.parameters && operation.parameters.length !== 0);
  if (!hasParameters && !hasRequestBody && getCommonParams(path, oas).length === 0) return null;

  const typeKeys = Object.keys(types);
  return [getBodyParam(operation, oas)]
    .concat(...getOtherParams(path, operation, oas))
    .filter(Boolean)
    .sort((a, b) => {
      return typeKeys.indexOf(a.type) - typeKeys.indexOf(b.type);
    });
};

// Exported for use in oas-to-har for default values object
module.exports.types = types;
