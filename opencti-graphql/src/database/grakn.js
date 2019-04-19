/* eslint-disable no-await-in-loop */
import uuid from 'uuid/v4';
import {
  assoc,
  chain,
  includes,
  groupBy,
  head,
  join,
  last,
  map,
  mapObjIndexed,
  pipe,
  pluck,
  fromPairs,
  toPairs,
  tail,
  isEmpty,
  isNil
} from 'ramda';
import moment from 'moment';
import { cursorToOffset } from 'graphql-relay/lib/connection/arrayconnection';
import Grakn from 'grakn-client';
import conf, { logger } from '../config/conf';
import { pubsub } from './redis';
import { fillTimeSeries, randomKey, buildPagination } from './utils';
import { isInversed } from './graknRoles';
import { getAttributes as elGetAttributes } from './elasticSearch';
import { Unknown } from '../config/errors';

// Global variables
const dateFormat = 'YYYY-MM-DDTHH:mm:ss';
const String = 'String';
const Date = 'Date';
export const now = () =>
  moment()
    .utc()
    .format(dateFormat); // Format that accept grakn
export const prepareDate = date =>
  moment(date)
    .utc()
    .format(dateFormat);
export const yearFormat = date => moment(date).format('YYYY');
export const monthFormat = date => moment(date).format('YYYY-MM');
export const dayFormat = date => moment(date).format('YYYY-MM-DD');
export const prepareString = s =>
  s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';

// Attributes key that can contains multiple values.
export const multipleAttributes = [
  'stix_label',
  'alias',
  'grant',
  'platform',
  'required_permission'
];
export const statsDateAttributes = [
  'first_seen', // Standard
  'last_seen', // Standard
  'published' // Standard
];

// Instance of Axios to make Grakn API Calls.
const client = new Grakn(
  `${conf.get('grakn:hostname')}:${conf.get('grakn:port')}`
);
let session = null;
client.session('grakn').then(graknSession => {
  session = graknSession;
});

export const takeReadTx = async () => {
  if (session === null) {
    session = await client.session('grakn');
  }
  return session.transaction().read();
};

export const takeWriteTx = async () => {
  if (session === null) {
    session = await client.session('grakn');
  }
  return session.transaction().write();
};

export const notify = (topic, instance, user, context) => {
  if (pubsub) pubsub.publish(topic, { instance, user, context });
  return instance;
};

export const write = async query => {
  const wTx = await takeWriteTx();
  await wTx.query(query);
  await wTx.commit();
};

/**
 * Load any grakn instance with internal grakn ID.
 * @param concept
 * @param graknAttributes
 * @returns {Promise<any[] | never>}
 */
export const getAttributes = async (concept, graknAttributes = false) => {
  const conceptType = await concept.type();
  const parentType = await conceptType.sup();
  const parentTypeLabel = await parentType.label();
  // temporary workaround due to Grakn performances
  if (
    !graknAttributes &&
    concept.isEntity() &&
    (parentTypeLabel === 'Stix-Domain-Entity' || parentTypeLabel === 'Identity')
  ) {
    const attributes = await elGetAttributes(
      'stix-domain-entities',
      'stix_domain_entity',
      concept.id
    );
    if (!isEmpty(attributes) && !isNil(attributes)) {
      return pipe(
        assoc('id', concept.id),
        assoc('parent_type', parentTypeLabel)
      )(attributes);
    }
  }
  const attributesIterator = await concept.attributes();
  const attributes = await attributesIterator.collect();
  const attributesPromises = attributes.map(async attribute => {
    const attributeType = await attribute.type();
    return {
      'data-type': await attributeType.dataType(),
      type: await attributeType.label(),
      value: await attribute.value()
    };
  });
  const resultPromise = Promise.all(attributesPromises).then(attributesData => {
    const transform = pipe(
      map(attribute => {
        let transformedVal = attribute.value;
        const type = attribute['data-type'];
        if (type === Date) {
          transformedVal = `${moment(attribute.value).format(dateFormat)}Z`;
        }
        if (type === String) {
          transformedVal = attribute.value
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
        }
        return { [attribute.type]: transformedVal };
      }), // Extract values
      chain(toPairs), // Convert to pairs for grouping
      groupBy(head), // Group by key
      map(pluck(1)), // Remove grouping boilerplate
      mapObjIndexed((num, key, obj) =>
        obj[key].length === 1 && !includes(key, multipleAttributes)
          ? head(obj[key])
          : head(obj[key]) && head(obj[key]).length > 0
          ? obj[key]
          : []
      ) // Remove extra list then contains only 1 element
    )(attributesData);
    return Promise.resolve(
      pipe(
        assoc('id', concept.id),
        assoc('parent_type', parentTypeLabel)
      )(transform)
    );
  });
  return Promise.resolve(resultPromise);
};

/**
 * Load any grakn instance with internal grakn ID.
 * @param id
 * @param tx
 * @param graknAttributes
 * @returns {Promise<any[] | never>}
 */
export const getById = async (id, tx = null, graknAttributes = false) => {
  let iTx = null;
  if (tx === null) {
    iTx = await takeReadTx();
  } else {
    iTx = tx;
  }
  try {
    const query = `match $x id ${id}; get $x;`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    const iterator = await iTx.query(query);
    const answer = await iterator.next();
    const concept = answer.map().get('x');
    const result = await getAttributes(concept, graknAttributes);
    if (tx === null) {
      await iTx.close();
    }
    return result;
  } catch (error) {
    if (tx === null && iTx) {
      iTx.close();
    }
    return Promise.resolve({});
  }
};

/**
 * Query and get entities of the first row
 * @param query
 * @param entities
 * @returns {Promise<any[] | never>}
 */
export const queryOne = async (query, entities) => {
  const rTx = await takeReadTx();
  try {
    logger.debug(`[GRAKN - infer: false] ${query}`);
    const iterator = await rTx.query(query);
    const answer = await iterator.next();
    const entitiesPromises = await entities.map(async entity => {
      return [entity, await getAttributes(answer.map().get(entity))];
    });
    const resultPromise = Promise.all(entitiesPromises).then(data => {
      return fromPairs(data);
    });
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve({});
  }
};

/**
 * Query and get entities
 * @param query
 * @param entities
 * @returns {Promise<any[] | never>}
 */
export const queryMultiple = async (query, entities) => {
  const rTx = await takeReadTx();
  try {
    logger.debug(`[GRAKN - infer: false] ${query}`);
    const iterator = await rTx.query(query);
    const answers = await iterator.collect();
    const resultPromise = Promise.all(
      answers.map(async answer => {
        const entitiesPromises = await entities.map(async entity => {
          return [entity, await getAttributes(answer.map().get(entity))];
        });
        return Promise.all(entitiesPromises).then(data => {
          return fromPairs(data);
        });
      })
    );
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};

/**
 * Load any grakn relation with internal grakn ID.
 * @param id
 * @returns {Promise<any[] | never>}
 */
export const getRelationById = async id => {
  const rTx = await takeReadTx();
  try {
    const query = `match $x($from, $to) isa relation; $x id ${id}; get;`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    const iterator = await rTx.query(query);
    const answer = await iterator.next();
    const relationPromise = await getAttributes(answer.map().get('x')).then(
      result => assoc('inferred', false, result)
    );
    const fromPromise = await getAttributes(answer.map().get('from'));
    const toPromise = await getAttributes(answer.map().get('to'));
    const resultPromise = Promise.all([
      relationPromise,
      fromPromise,
      toPromise
    ]).then(([relation, from, to]) => {
      if (
        isInversed(relation.relationship_type, from.entity_type, to.entity_type)
      ) {
        return pipe(
          assoc('from', to),
          assoc('to', from)
        )(relation);
      }
      return pipe(
        assoc('from', from),
        assoc('to', to)
      )(relation);
    });
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve({});
  }
};

/**
 * Load any grakn relation with base64 id containing the query pattern.
 * @param id
 * @returns {Promise<any[] | never>}
 */
export const getRelationInferredById = async id => {
  const rTx = await takeReadTx();
  try {
    const decodedQuery = Buffer.from(id, 'base64').toString('ascii');
    const query = `match ${decodedQuery} get;`;
    const queryRegex = /\$([a-z_\d]+)\s?[([a-z_]+:\s\$(\w+),\s[a-z_]+:\s\$(\w+)\)\s[a-z_]+\s([\w-]+);/i.exec(
      query
    );
    const relKey = queryRegex[1];
    const fromKey = queryRegex[2];
    const toKey = queryRegex[3];
    logger.debug(`[GRAKN - infer: true] ${query}`);
    const answerIterator = await rTx.query(query);
    const answer = await answerIterator.next();
    const rel = answer.map().get(relKey);
    const relationType = await rel.type();
    const relationTypeValue = await relationType.label();
    const from = answer.map().get(fromKey);
    const to = answer.map().get(toKey);
    const relationPromise = await Promise.resolve({
      id,
      type: 'stix_relation',
      relationship_type: relationTypeValue,
      inferred: true
    });
    const fromPromise = await getAttributes(from);
    const toPromise = await getAttributes(to);
    const explanation = answer.explanation();
    const explanationAnswers = explanation.answers();
    const inferences = explanationAnswers.map(explanationAnswer => {
      const explanationAnswerExplanation = explanationAnswer.explanation();
      let inferenceQuery = explanationAnswerExplanation.queryPattern();
      const inferenceQueryRegex = /(\$(\d+|rel)\s)?\([a-z_]+:\s\$(\w+),\s[a-z_]+:\s\$(\w+)\)\sisa\s([\w-]+);/i.exec(
        inferenceQuery
      );
      let relationKey;
      if (inferenceQueryRegex[2] !== undefined) {
        relationKey = inferenceQueryRegex[2];
      } else {
        relationKey = randomKey(5);
        inferenceQuery = inferenceQuery.replace('(', `$${relationKey} (`);
      }
      return {
        inferenceQuery,
        relationKey,
        fromKey: inferenceQueryRegex[3],
        toKey: inferenceQueryRegex[4],
        relationType: inferenceQueryRegex[5]
      };
    });
    const inferencesQueries = pluck('inferenceQuery', inferences);
    const inferencesQuery = `match {${join(' ', inferencesQueries)} }; get;`;
    const inferencesAnswerIterator = await rTx.query(inferencesQuery);
    const inferencesAnswer = await inferencesAnswerIterator.next();
    const inferencesPromises = Promise.all(
      inferences.map(async inference => {
        const inferred = await inferencesAnswer
          .map()
          .get(inference.relationKey)
          .isInferred();
        const inferenceFrom = inferencesAnswer.map().get(inference.fromKey);
        const inferenceTo = inferencesAnswer.map().get(inference.toKey);
        let inferenceId;
        if (inferred) {
          const inferenceQueryRegex = /\$([a-z_\d]+)\s\([a-z_:]+\s\$([a-z_]+),\s[a-z_:]+\s\$([a-z_]+)\)/i.exec(
            inference.inferenceQuery
          );
          const entityFromKey = inferenceQueryRegex[2];
          const entityToKey = inferenceQueryRegex[3];
          const regexFromString = `\\$${entityFromKey}\\sid\\s(V\\d+);`;
          const regexFrom = new RegExp(regexFromString, 'i');
          const inferenceQueryRegexFrom = inference.inferenceQuery.match(
            regexFrom
          );
          const regexToString = `\\$${entityToKey}\\sid\\s(V\\d+);`;
          const regexTo = new RegExp(regexToString, 'i');
          const inferenceQueryRegexTo = inference.inferenceQuery.match(regexTo);

          const regexFromTypeString = `\\$${entityFromKey}\\sisa\\s[\\w-_]+;`;
          const regexFromType = new RegExp(regexFromTypeString, 'ig');
          const regexToTypeString = `\\$${entityToKey}\\sisa\\s[\\w-_]+;`;
          const regexToType = new RegExp(regexToTypeString, 'ig');

          let inferenceQuery;
          if (inferenceQueryRegexFrom && inferenceQueryRegexTo) {
            inferenceQuery = inference.inferenceQuery;
          } else if (inferenceQueryRegexFrom) {
            const existingId = inferenceQueryRegexFrom[1];
            inferenceQuery = inference.inferenceQuery.replace(
              `$${entityFromKey} id ${existingId};`,
              `$${entityFromKey} id ${existingId}; $${entityToKey} id ${
                existingId === inferenceFrom.id
                  ? inferenceTo.id
                  : inferenceFrom.id
              };`
            );
          } else if (inferenceQueryRegexTo) {
            const existingId = inferenceQueryRegexTo[1];
            inferenceQuery = inference.inferenceQuery.replace(
              `$${entityToKey} id ${existingId};`,
              `$${entityToKey} id ${existingId}; $${entityFromKey} id ${
                existingId === inferenceFrom.id
                  ? inferenceTo.id
                  : inferenceFrom.id
              };`
            );
          } else {
            inferenceQuery = inference.inferenceQuery;
          }
          inferenceQuery = inferenceQuery
            .replace(regexFromType, '')
            .replace(regexToType, '');
          inferenceId = Buffer.from(inferenceQuery).toString('base64');
        } else {
          inferenceId = inferencesAnswer.map().get(inference.relationKey).id;
        }
        const fromAttributes = await getAttributes(inferenceFrom);
        const toAttributes = await getAttributes(inferenceTo);
        return {
          node: {
            id: inferenceId,
            inferred,
            relationship_type: inference.relationType,
            from: fromAttributes,
            to: toAttributes
          }
        };
      })
    );
    const resultPromise = Promise.all([
      relationPromise,
      fromPromise,
      toPromise,
      inferencesPromises
    ]).then(([node, fromResult, toResult, relationInferences]) => {
      if (
        isInversed(
          node.relationship_type,
          fromResult.entity_type,
          toResult.entity_type
        )
      ) {
        return pipe(
          assoc('from', toResult),
          assoc('to', fromResult),
          assoc('inferences', { edges: relationInferences })
        )(node);
      }
      return pipe(
        assoc('from', fromResult),
        assoc('to', toResult),
        assoc('inferences', { edges: relationInferences })
      )(node);
    });
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve({});
  }
};

/**
 * Get a single value from a Grakn query
 * @param query
 * @param infer
 * @returns {Promise<any[] | never>}
 */
export const getSingleValue = async (query, infer = false) => {
  logger.debug(`[GRAKN - infer: ${infer}] ${query}`);
  const rTx = await takeReadTx();
  try {
    const iterator = await rTx.query(query, { infer });
    const answer = await iterator.next();
    const result = await Promise.resolve(answer);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve({});
  }
};

/**
 * Get a single value number
 * @param query
 * @param infer
 * @returns number
 */
export const getSingleValueNumber = async (query, infer = false) => {
  try {
    return getSingleValue(query, infer).then(data => data.number());
  } catch (error) {
    return Promise.resolve(null);
  }
};

/**
 * Grakn query that generate json objects
 * @param query the query to process
 * @param key the instance key to get id from.
 * @param relationKey the key to bind relation result.
 * @param infer
 * @returns {Promise<any[] | never>}
 */
export const getObjects = async (
  query,
  key = 'x',
  relationKey,
  infer = false
) => {
  const rTx = await takeReadTx();
  try {
    logger.debug(`[GRAKN - infer: ${infer}] ${query}`);
    const iterator = await rTx.query(query, { infer });
    const answers = await iterator.collect();
    const resultPromise = Promise.all(
      answers.map(async answer => {
        const nodePromise = await getAttributes(answer.map().get(key));
        let relationPromise = await Promise.resolve(null);
        if (relationKey) {
          if (
            answer
              .map()
              .get(relationKey)
              .isInferred()
          ) {
            const relationType = await answer
              .map()
              .get(relationKey)
              .type();
            relationPromise = await Promise.resolve({
              id: answer.map().get(relationKey).id,
              type: 'stix_relation',
              relationship_type: relationType.label(),
              inferred: true
            });
          } else {
            const relationData = await getAttributes(
              answer.map().get(relationKey)
            ).then(data => assoc('inferred', false, data));
            relationPromise = await Promise.resolve(relationData);
          }
        }
        return Promise.all([nodePromise, relationPromise]).then(
          ([node, relation]) => ({
            node,
            relation
          })
        );
      })
    );
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};

/**
 * Grakn query that generate json objects for GraphQL
 * @param query the query to process
 * @param key the instance key to get id from.
 * @param relationKey the key to bind relation result.
 * @param infer
 * @returns {Promise<any[] | never>}
 */
export const getObjectsWithoutAttributes = async (
  query,
  key = 'x',
  relationKey,
  infer = false
) => {
  const rTx = await takeReadTx();
  try {
    logger.debug(`[GRAKN - infer: ${infer}] ${query}`);
    const iterator = await rTx.query(query, { infer });
    const answers = await iterator.collect();
    const resultPromise = Promise.all(
      answers.map(async answer => {
        const nodePromise = await Promise.resolve({
          id: answer.map().get(key).id
        });
        let relationPromise = await Promise.resolve(null);
        if (relationKey) {
          const relationType = await answer
            .map()
            .get(relationKey)
            .type();
          relationPromise = await Promise.resolve({
            id: answer.map().get(relationKey).id,
            type: 'stix_relation',
            relationship_type: relationType.label(),
            inferred: await answer
              .map()
              .get(relationKey)
              .isInferred()
          });
        }
        return Promise.all([nodePromise, relationPromise]).then(
          ([node, relation]) => ({
            node,
            relation
          })
        );
      })
    );
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};

/**
 * Grakn query that generate a json object for GraphQL
 * @param query the query to process
 * @param key the instance key to get id from.
 * @param relationKey the key to bind relation result.
 * @param infer
 * @returns {Promise<any[] | never>}
 */
export const getObject = (query, key = 'x', relationKey, infer = false) =>
  getObjects(query, key, relationKey, infer).then(result => head(result));

/**
 * Grakn generic pagination query.
 * @param query
 * @param options
 * @param ordered
 * @param relationOrderingKey
 * @param infer
 * @returns {Promise<any[] | never>}
 */
export const paginate = (
  query,
  options,
  ordered = true,
  relationOrderingKey = null,
  infer = false
) => {
  const { first = 200, after, orderBy = null, orderMode = 'asc' } = options;
  const offset = after ? cursorToOffset(after) : 0;
  const instanceKey = /match\s(?:\$|{\s\$)(\w+)[\s]/i.exec(query)[1]; // We need to resolve the key instance used in query.
  const findRelationVariable = /\$(\w+)\((\w+):\$(\w+),[\s\w:$]+\)/i.exec(
    query
  );
  const relationKey = findRelationVariable && findRelationVariable[1]; // Could be setup to get relation info
  const orderingKey = relationOrderingKey
    ? `$${relationOrderingKey} has ${orderBy} $o;`
    : `$${instanceKey} has ${orderBy} $o;`;
  const count = getSingleValueNumber(
    `${query}; ${ordered && orderBy ? orderingKey : ''} get $${instanceKey}${
      relationKey ? `, $${relationKey}` : ''
    }${ordered && orderBy ? ', $o' : ''}; count;`,
    infer
  );
  const elements = getObjects(
    `${query}; ${ordered && orderBy ? orderingKey : ''} get $${instanceKey}${
      relationKey ? `, $${relationKey}` : ''
    }${ordered && orderBy ? ', $o' : ''}; ${
      ordered && orderBy ? `sort $o ${orderMode};` : ''
    } offset ${offset}; limit ${first};`,
    instanceKey,
    relationKey,
    infer
  );
  return Promise.all([count, elements]).then(data => {
    const globalCount = data ? head(data) : 0;
    const instances = data ? last(data) : [];
    return buildPagination(first, offset, instances, globalCount);
  });
};

/**
 * Grakn query that generate json objects for relations
 * @param query the query to process
 * @param key the instance key to get id from.
 * @param fromKey the key to bind relation result.
 * @param toKey the key to bind relation result.
 * @param extraRelKey the key of the relation pointing the relation
 * @param infer (get inferred relationships)
 * @returns {Promise<any[] | never>}
 */
export const getRelations = async (
  query,
  key = 'rel',
  fromKey = 'from',
  toKey = 'to',
  extraRelKey,
  infer = false
) => {
  const rTx = await takeReadTx();
  try {
    logger.debug(`[GRAKN - infer: ${infer}] ${query}`);
    const iterator = await rTx.query(query, { infer });
    const answers = await iterator.collect();
    const resultPromise = Promise.all(
      answers.map(async answer => {
        const relationObject = await answer.map().get(key);
        const relationType = await relationObject.type();
        const relationIsInferred = await relationObject.isInferred();
        let relationPromise = await Promise.resolve(null);
        if (relationIsInferred) {
          const explanation = answer.explanation();
          let queryPattern = explanation.queryPattern();
          queryPattern = queryPattern
            .replace(
              `$from id ${answer.map().get(fromKey).id};`,
              `$from id ${answer.map().get(fromKey).id}; $to id ${
                answer.map().get(toKey).id
              };`
            )
            .replace(/\$from\sisa\s[\w-_]+;/gi, '')
            .replace(/\$to\sisa\s[\w-_]+;/gi, '');
          relationPromise = await Promise.resolve({
            id: Buffer.from(queryPattern).toString('base64'),
            type: 'stix_relation',
            relationship_type: await relationType.label(),
            inferred: true
          });
        } else {
          const relationData = await getAttributes(answer.map().get(key)).then(
            data => assoc('inferred', false, data)
          );
          relationPromise = await Promise.resolve(relationData);
        }
        const fromPromise = getAttributes(answer.map().get(fromKey));
        const toPromise = getAttributes(answer.map().get(toKey));
        const extraRelationPromise = !extraRelKey
          ? Promise.resolve(null)
          : getAttributes(answer.map().get(extraRelKey));

        return Promise.all([
          relationPromise,
          fromPromise,
          toPromise,
          extraRelationPromise
        ]).then(([node, from, to, relation]) => {
          if (
            isInversed(node.relationship_type, from.entity_type, to.entity_type)
          ) {
            return {
              node: pipe(
                assoc('from', to),
                assoc('to', from)
              )(node),
              relation
            };
          }
          return {
            node: pipe(
              assoc('from', from),
              assoc('to', to)
            )(node),
            relation
          };
        });
      })
    );
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};

/**
 * Grakn generic pagination query
 * @param query
 * @param options
 * @param extraRel
 * @param pagination
 * @returns Promise
 */
export const paginateRelationships = (
  query,
  options,
  extraRel = null,
  pagination = true
) => {
  const {
    fromId,
    toId,
    fromTypes,
    toTypes,
    firstSeenStart,
    firstSeenStop,
    lastSeenStart,
    lastSeenStop,
    weights,
    inferred,
    first = 200,
    after,
    orderBy,
    orderMode = 'asc'
  } = options;
  const offset = after ? cursorToOffset(after) : 0;
  const finalQuery = `
  ${query};
  ${fromId ? `$from id ${fromId};` : ''}
  ${toId ? `$to id ${toId};` : ''} ${
    fromTypes && fromTypes.length > 0
      ? `${join(
          ' ',
          map(fromType => `{ $from isa ${fromType}; } or`, fromTypes)
        )} { $from isa ${head(fromTypes)}; };`
      : ''
  } ${
    toTypes && toTypes.length > 0
      ? `${join(' ', map(toType => `{ $to isa ${toType}; } or`, toTypes))}
  { $to isa ${head(toTypes)}; };`
      : ''
  } ${firstSeenStart || firstSeenStop ? `$rel has first_seen $fs; ` : ''} ${
    firstSeenStart ? `$fs > ${prepareDate(firstSeenStart)}; ` : ''
  } ${firstSeenStop ? `$fs < ${prepareDate(firstSeenStop)}; ` : ''} ${
    lastSeenStart || lastSeenStop ? `$rel has last_seen $ls; ` : ''
  } ${lastSeenStart ? `$ls > ${prepareDate(lastSeenStart)}; ` : ''} ${
    lastSeenStop ? `$ls < ${prepareDate(lastSeenStop)}; ` : ''
  } ${
    weights
      ? `$rel has weight $weight; ${join(
          ' ',
          map(weight => `{ $weight == ${weight}; } or`, weights)
        )} { $weight == 0; };`
      : ''
  }`;
  const orderingKey = orderBy ? `$rel has ${orderBy} $o;` : '';
  const count = getSingleValueNumber(
    `${finalQuery} ${orderingKey} get $rel, $from, $to ${
      extraRel ? `, $${extraRel}` : ''
    }${orderBy ? ', $o' : ''}; count;`,
    inferred
  );
  const elements = getRelations(
    `${finalQuery} ${orderingKey} get $rel, $from, $to${
      extraRel ? `, $${extraRel}` : ''
    }${orderBy ? ', $o' : ''}; ${
      orderBy ? `sort $o ${orderMode};` : ''
    } offset ${offset}; limit ${first};`,
    'rel',
    'from',
    'to',
    extraRel,
    inferred
  );
  if (pagination) {
    return Promise.all([count, elements]).then(data => {
      const globalCount = data ? head(data) : 0;
      const instances = data ? last(data) : [];
      return buildPagination(first, offset, instances, globalCount);
    });
  }
  return Promise.all([count, elements]).then(data => {
    const globalCount = data ? head(data) : 0;
    const instances = data ? last(data) : [];
    return { globalCount, instances };
  });
};

/**
 * Create a relation between to element in the model without restriction.
 * @param id
 * @param input
 * @returns {Promise<any[] | never>}
 */
export const createRelation = async (id, input) => {
  const wTx = await takeWriteTx();
  try {
    const query = `match $from id ${id};
      $to id ${input.toId}; 
      insert $rel(${input.fromRole}: $from, ${input.toRole}: $to) isa ${
      input.through
    } ${input.stix_id ? `, has relationship_type "${input.through}"` : ''}
        ${
          input.stix_id
            ? input.stix_id === 'create'
              ? `, has stix_id "relationship--${uuid()}"`
              : `, has stix_id "${prepareString(input.stix_id)}"`
            : ''
        } ${
      input.first_seen
        ? `, has first_seen ${prepareDate(input.first_seen)}`
        : ''
    } ${
      input.last_seen ? `, has last_seen ${prepareDate(input.last_seen)}` : ''
    } ${input.weight ? `, has weight ${input.weight}` : ''};`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    const iterator = await wTx.query(query);
    const answer = await iterator.next();
    const createdRelation = await answer.map().get('rel');
    const nodePromise = await getById(input.toId, wTx);
    const relationPromise = await getAttributes(createdRelation);
    await wTx.commit();
    return Promise.all([nodePromise, relationPromise]).then(
      ([node, relation]) => ({
        node,
        relation
      })
    );
  } catch (error) {
    if (wTx) {
      wTx.close();
    }
    throw new Unknown();
  }
};

/**
 * Edit an attribute value.
 * @param id
 * @param input
 * @param tx
 * @returns the complete instance
 */
export const updateAttribute = async (id, input, tx = null) => {
  const { key, value } = input; // value can be multi valued
  // 00. If the transaction already exist, just continue the process
  let wTx = null;
  if (tx === null) {
    wTx = await takeWriteTx();
  } else {
    wTx = tx;
  }
  try {
    // 01. We need to fetch the type to quote the string if needed.
    const labelTypeQuery = `match $x type ${key}; get;`;
    const labelIterator = await wTx.query(labelTypeQuery);
    const labelAnswer = await labelIterator.next();
    // eslint-disable-next-line prettier/prettier
    const attrType = await labelAnswer
      .map()
      .get('x')
      .dataType();
    // 02. For each old values
    const getOldValueQuery = `match $x id ${id}; $x has ${key} $old; get $old;`;
    logger.debug(`[GRAKN - infer: false] ${getOldValueQuery}`);
    const oldValIterator = await wTx.query(getOldValueQuery);
    const oldValuesConcept = await oldValIterator.collectConcepts();
    for (let i = 0; i < oldValuesConcept.length; i += 1) {
      const oldValue = await oldValuesConcept[i].value();
      const typedOldValue =
        attrType === String
          ? `"${prepareString(
              oldValue.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            )}"`
          : attrType === Date
          ? prepareDate(oldValue)
          : oldValue;
      // If the attribute is alone we can delete it, if not we need to remove the relation to it (via)
      const countRemainQuery = `match $x isa ${key}; $x == ${typedOldValue}; $rel($x); get; count;`;
      logger.debug(`[GRAKN - infer: false] ${countRemainQuery}`);
      const countRemainIterator = await wTx.query(countRemainQuery);
      const countRemain = await countRemainIterator.next();
      const oldNumOfRef = await countRemain.number();
      // Start the delete phase
      let deleteQuery = null;
      if (oldNumOfRef > 1) {
        // In this case we need to remove the reference to the value
        deleteQuery = `match $x id ${id}; $x has ${key} $del via $d; $del == ${typedOldValue}; delete $d;`;
      } else {
        // In this case the instance of the attribute can be removed
        const attrGetQuery = `match $x isa ${key}; $x == ${typedOldValue}; $rel($x); get $x;`;
        const attrIterator = await wTx.query(attrGetQuery);
        const attrAnswer = await attrIterator.next();
        if (attrAnswer) {
          const attrId = await attrAnswer.map().get('x').id;
          deleteQuery = `match $attr id ${attrId}; delete $attr;`;
        }
      }
      if (deleteQuery) {
        logger.debug(`[GRAKN - infer: false] ${deleteQuery}`);
        await wTx.query(deleteQuery);
      }
    }
    // Setup the new attribute
    let typedValues = map(
      v => (attrType === String ? `"${prepareString(v)}"` : v),
      value
    );
    if (typedValues.length === 0) {
      typedValues = [attrType === String ? '""' : ''];
    }
    let graknValues;
    if (typedValues.length === 1) {
      graknValues = `has ${key} ${head(typedValues)}`;
    } else {
      graknValues = `${join(
        ' ',
        map(val => `has ${key} ${val},`, tail(typedValues))
      )} has ${key} ${head(typedValues)}`;
    }
    const createQuery = `match $m id ${id}; insert $m ${graknValues};`;
    logger.debug(`[GRAKN - infer: false] ${createQuery}`);
    await wTx.query(createQuery);

    if (includes(key, statsDateAttributes)) {
      const dayValue = dayFormat(head(value));
      const monthValue = monthFormat(head(value));
      const yearValue = yearFormat(head(value));
      const dayInput = { key: `${key}_day`, value: [dayValue] };
      await updateAttribute(id, dayInput, wTx);
      const monthInput = { key: `${key}_month`, value: [monthValue] };
      await updateAttribute(id, monthInput, wTx);
      const yearInput = { key: `${key}_year`, value: [yearValue] };
      await updateAttribute(id, yearInput, wTx);
    }

    if (tx !== null) {
      return true;
    }
    const result = await getById(id, wTx, true);
    await wTx.commit();
    return result;
  } catch (error) {
    if (tx === null && wTx) {
      wTx.close();
    }
    throw new Unknown();
  }
};

/**
 * Grakn generic function to delete an instance (and orphan relationships)
 * @param id
 * @returns {Promise<any[] | never>}
 */
export const deleteEntityById = async id => {
  const wTx = await takeWriteTx();
  try {
    const query = `match $x id ${id}; $z($x, $y); delete $z, $x;`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    await wTx.query(query, { infer: false });
    await wTx.commit();
    return Promise.resolve(id);
  } catch (error) {
    if (wTx) {
      wTx.close();
    }
    throw new Unknown();
  }
};

/**
 * Grakn generic function to delete an entity by id
 * @param id
 * @returns {Promise<any[] | never>}
 */
export const deleteById = async id => {
  const wTx = await takeWriteTx();
  try {
    const query = `match $x id ${id}; delete $x;`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    await wTx.query(query, { infer: false });
    await wTx.commit();
    return Promise.resolve(id);
  } catch (error) {
    if (wTx) {
      wTx.close();
    }
    throw new Unknown();
  }
};

/**
 * Grakn generic function to delete a relationship
 * @param id
 * @param relationId
 * @returns {Promise<any[] | never>}
 */
export const deleteRelationById = async (id, relationId) => {
  const wTx = await takeWriteTx();
  try {
    const query = `match $x id ${relationId}; delete $x;`;
    logger.debug(`[GRAKN - infer: false] ${query}`);
    await wTx.query(query, { infer: false });
    await wTx.commit();
    return getById(id).then(data => ({
      node: data,
      relation: { id: relationId }
    }));
  } catch (error) {
    if (wTx) {
      wTx.close();
    }
    throw new Unknown();
  }
};

/**
 * Grakn generic timeseries
 * @param query
 * @param options
 * @returns Promise
 */
export const timeSeries = async (query, options) => {
  const {
    startDate,
    endDate,
    operation,
    field,
    interval,
    inferred = true
  } = options;
  const rTx = await takeReadTx();
  try {
    const finalQuery = `${query}; $x has ${field}_${interval} $g; get; group $g; ${operation};`;
    logger.debug(`[GRAKN - infer: ${inferred}] ${finalQuery}`);
    const iterator = await rTx.query(finalQuery, { infer: inferred });
    const answer = await iterator.collect();
    const resultPromise = Promise.all(
      answer.map(async n => {
        const date = await n.owner().value();
        const number = await n.answers()[0].number();
        return { date, value: number };
      })
    ).then(result => fillTimeSeries(startDate, endDate, interval, result));
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};

/**
 * Grakn generic distribution
 * @param query
 * @param options
 * @returns Promise
 */
export const distribution = async (query, options) => {
  const { operation, field, inferred = false } = options;
  const rTx = await takeReadTx();
  try {
    const finalQuery = `${query}; $x has ${field} $g; get; group $g; ${operation};`;
    logger.debug(`[GRAKN - infer: ${inferred}] ${finalQuery}`);
    const iterator = await rTx.query(finalQuery, { infer: inferred });
    const answer = await iterator.collect();
    const resultPromise = Promise.all(
      answer.map(async n => {
        const label = await n.owner().value();
        const number = await n.answers()[0].number();
        return { label, value: number };
      })
    );
    const result = await Promise.resolve(resultPromise);
    await rTx.close();
    return result;
  } catch (error) {
    if (rTx) {
      rTx.close();
    }
    return Promise.resolve([]);
  }
};
