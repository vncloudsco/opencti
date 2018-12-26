import { head } from 'ramda';
import uuid from 'uuid/v4';
import { delEditContext, pubsub, setEditContext } from '../database/redis';
import {
  createRelation,
  deleteByID,
  editInputTx,
  loadByID,
  notify,
  now,
  paginate,
  qk
} from '../database/grakn';
import { BUS_TOPICS } from '../config/conf';

export const findAll = args => paginate('match $m isa Threat-Actor', args);

export const markingDefinitions = (threatActorId, args) =>
  paginate(
    `match $marking isa Marking-Definition; 
    (marking:$marking, so:$threatActor) isa object_marking_refs; 
    $threatActor id ${threatActorId}`,
    args
  );

export const findById = threatActorId => loadByID(threatActorId);

export const addThreatActor = async (user, threatActor) => {
  const createThreatActor = qk(`insert $threatActor isa Threat-Actor 
    has type "threat-actor";
    $threatActor has stix_id "threat-actor--${uuid()}";
    $threatActor has name "${threatActor.name}";
    $threatActor has description "${threatActor.description}";
    $threatActor has created ${now()};
    $threatActor has modified ${now()};
    $threatActor has revoked false;
    $threatActor has created_at ${now()};
    $threatActor has updated_at ${now()};
  `);
  return createThreatActor.then(result => {
    const { data } = result;
    return findById(head(data).threatActor.id).then(created =>
      notify(BUS_TOPICS.ThreatActor.ADDED_TOPIC, created)
    );
  });
};

export const threatActorDelete = threatActorId => deleteByID(threatActorId);

export const threatActorDeleteRelation = relationId => deleteByID(relationId);

export const threatActorAddRelation = (threatActorId, input) =>
  createRelation(threatActorId, input).then(threatActor =>
    notify(BUS_TOPICS.ThreatActor.EDIT_TOPIC, threatActor)
  );

export const threatActorCleanContext = (user, threatActorId) => {
  delEditContext(user, threatActorId);
  return findById(threatActorId).then(threatActor =>
    notify(BUS_TOPICS.ThreatActor.EDIT_TOPIC, threatActor)
  );
};

export const threatActorEditContext = (user, threatActorId, input) => {
  setEditContext(user, threatActorId, input);
  findById(threatActorId).then(threatActor =>
    notify(BUS_TOPICS.ThreatActor.EDIT_TOPIC, threatActor)
  );
};

export const threatActorEditField = (threatActorId, input) =>
  editInputTx(threatActorId, input).then(threatActor =>
    notify(BUS_TOPICS.ThreatActor.EDIT_TOPIC, threatActor)
  );