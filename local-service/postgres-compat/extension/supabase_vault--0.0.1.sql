CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  secret text NOT NULL
);

CREATE FUNCTION vault.create_secret(new_secret text, new_name text, new_description text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  created uuid;
BEGIN
  INSERT INTO vault.secrets (name, secret) VALUES (new_name, new_secret) RETURNING id INTO created;
  RETURN created;
END;
$$;

CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vault.secrets
     SET secret = new_secret,
         name = COALESCE(new_name, name)
   WHERE id = secret_id;
END;
$$;
