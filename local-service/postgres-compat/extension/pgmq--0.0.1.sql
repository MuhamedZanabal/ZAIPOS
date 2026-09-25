CREATE SCHEMA IF NOT EXISTS pgmq;

CREATE TABLE pgmq.queues (
  queue_name text PRIMARY KEY,
  next_id bigint NOT NULL DEFAULT 1
);

CREATE TABLE pgmq.messages (
  queue_name text NOT NULL,
  msg_id bigint NOT NULL,
  read_ct integer NOT NULL DEFAULT 0,
  message jsonb NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  vt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_name, msg_id)
);

CREATE FUNCTION pgmq.create(queue_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pgmq.queues AS queues (queue_name) VALUES (create.queue_name) ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION pgmq.send(queue_name text, msg jsonb) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
BEGIN
  INSERT INTO pgmq.queues AS queues (queue_name) VALUES (send.queue_name) ON CONFLICT DO NOTHING;
  UPDATE pgmq.queues AS queues
     SET next_id = queues.next_id + 1
   WHERE queues.queue_name = send.queue_name
  RETURNING queues.next_id - 1 INTO new_id;
  INSERT INTO pgmq.messages (queue_name, msg_id, message) VALUES (send.queue_name, new_id, msg);
  RETURN new_id;
END;
$$;

CREATE TYPE pgmq.message_record AS (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
);

CREATE FUNCTION pgmq.read(queue_name text, vt integer, qty integer)
RETURNS SETOF pgmq.message_record
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT messages.msg_id, messages.read_ct, messages.enqueued_at, messages.vt, messages.message
    FROM pgmq.messages AS messages
   WHERE messages.queue_name = read.queue_name
   ORDER BY messages.msg_id
   LIMIT read.qty;
END;
$$;

CREATE FUNCTION pgmq.delete(queue_name text, msg_id bigint) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM pgmq.messages AS messages
   WHERE messages.queue_name = delete.queue_name
     AND messages.msg_id = delete.msg_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed > 0;
END;
$$;
