import { authOptions } from "../../auth/[...nextauth]";
import { getServerSession } from "next-auth/next";

import connectMongo from "@config/mongo";
import logger from "@config/logger";
import { serverEnv } from "@config/schemas/serverSchema";
import Profile from "@models/Profile";
import logChange from "@models/middlewares/logChange";

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  const username = session.username;
  if (!["GET", "PATCH"].includes(req.method)) {
    return res
      .status(400)
      .json({ error: "Invalid request: GET or PUT required" });
  }

  const context = { req, res };

  let profile = {};
  if (req.method === "GET") {
    profile = await getSettingsApi(username);
  }
  if (req.method === "PATCH") {
    profile = await updateSettingsApi(context, username, req.body);
  }

  if (profile.error) {
    return res.status(400).json({ message: profile.error });
  }
  return res.status(200).json(profile);
}

export async function getSettingsApi(username) {
  await connectMongo();
  const log = logger.child({ username });

  let getProfile = await Profile.findOne({ username }, ["settings"]);

  if (!getProfile) {
    log.info(`peofile not found for username: ${username}`);
    return { error: "Profile not found." };
  }

  return JSON.parse(JSON.stringify(getProfile.settings));
}

export async function updateSettingsApi(context, username, data) {
  await connectMongo();
  const log = logger.child({ username });

  const beforeUpdate = await getSettingsApi(username);

  let getProfile = {};
  try {
    await Profile.validate({ data }, ["settings"]);
  } catch (e) {
    return { error: e.errors };
  }

  const update = { ...beforeUpdate, ...data };
  update.domain = update.domain.replaceAll(".", "|"); // TODO: use getter/setter instead
  try {
    getProfile = await Profile.findOneAndUpdate(
      { username },
      { source: "database", settings: update },
      {
        upsert: true,
        new: true,
      },
    );
    log.info(`profile premium settings updated for username: ${username}`);
  } catch (e) {
    log.error(e, `failed to updated profile premium for username: ${username}`);
  }

  beforeUpdate.domain = beforeUpdate.domain.replaceAll("|", "."); // TODO: use getter/setter instead
  if (data.domain !== beforeUpdate.domain) {
    log.info(
      `trying to update profile premium settings domain for username: ${username}`,
    );

    // remove previous custom domain if exists
    if (beforeUpdate.domain) {
      log.info(
        `attempting to remove existing domain "${beforeUpdate.domain}" for: ${username}`,
      );
      let domainRemoveRes;
      const domainRemoveUrl = `https://api.vercel.com/v6/domains/${beforeUpdate.domain}?teamId=${serverEnv.VERCEL_TEAM_ID}`;
      try {
        domainRemoveRes = await fetch(domainRemoveUrl, {
          headers: {
            Authorization: `Bearer ${serverEnv.VERCEL_AUTH_TOKEN}`,
          },
          method: "DELETE",
        });
        const domainRemoveJson = domainRemoveRes.json();
        log.info(
          `domain ${beforeUpdate.domain} removed for: ${username}`,
          domainRemoveJson,
        );
      } catch (e) {
        log.error(
          e,
          `failed to remove previous custom domain for username: ${username}`,
        );
      }
    }

    // add new custom domain
    if (data.domain) {
      log.info(`attempting to add domain "${data.domain}" for: ${username}`);
      let domainAddRes;
      const domainAddUrl = `https://api.vercel.com/v5/domains?teamId=${serverEnv.VERCEL_TEAM_ID}`;
      try {
        domainAddRes = await fetch(domainAddUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serverEnv.VERCEL_AUTH_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: data.domain }),
        });
        const domainAddJson = await domainAddRes.json();
        log.info(`domain ${data.domain} added for: ${username}`, domainAddJson);
      } catch (e) {
        log.error(
          e,
          `failed to add new custom domain "${data.domain}" for username: ${username}`,
        );
      }
    }
  }

  // Add to Changelog
  try {
    logChange(await getServerSession(context.req, context.res, authOptions), {
      model: "Profile",
      changesBefore: beforeUpdate,
      changesAfter: await getSettingsApi(username),
    });
  } catch (e) {
    log.error(
      e,
      `failed to record Settings changes in changelog for username: ${username}`,
    );
  }

  return JSON.parse(JSON.stringify(getProfile.settings));
}
