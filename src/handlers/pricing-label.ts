import { Context } from "../types/context";

import { createLabel, listLabelsForRepo, addLabelToIssue, clearAllPriceLabelsOnIssue } from "../shared/label";
import { Label } from "../types/github";
import { labelAccessPermissionsCheck } from "../shared/permissions";
import { setPrice } from "../shared/pricing";
import { handleParentIssue, isParentIssue, sortLabelsByValue } from "./handle-parent-issue";
import { AssistivePricingSettings } from "../types/plugin-input";
import { isIssueLabelEvent } from "../types/typeguards";

export async function onLabelChangeSetPricing(context: Context): Promise<void> {
  if (!isIssueLabelEvent(context)) {
    context.logger.debug("Not an issue event");
    return;
  }
  const config = context.config;
  const logger = context.logger;
  const payload = context.payload;

  const labels = payload.issue.labels;
  if (!labels) throw logger.error(`No labels to calculate price`);

  if (payload.issue.body && isParentIssue(payload.issue.body)) {
    await handleParentIssue(context, labels);
    return;
  }

  const hasPermission = await labelAccessPermissionsCheck(context);
  if (!hasPermission) {
    if (config.publicAccessControl.setLabel === false) {
      throw logger.error("No public access control to set labels");
    }
    throw logger.error("No permission to set labels");
  }

  // here we should make an exception if it was a price label that was just set to just skip this action
  const isPayloadToSetPrice = payload.label?.name.includes("Price: ");
  if (isPayloadToSetPrice) {
    logger.info("This is setting the price label directly so skipping the rest of the action.");

    // make sure to clear all other price labels except for the smallest price label.

    const priceLabels = labels.filter((label) => label.name.includes("Price: "));
    const sortedPriceLabels = sortLabelsByValue(priceLabels);
    const smallestPriceLabel = sortedPriceLabels.shift();
    const smallestPriceLabelName = smallestPriceLabel?.name;
    if (smallestPriceLabelName) {
      for (const label of sortedPriceLabels) {
        await context.octokit.issues.removeLabel({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          issue_number: payload.issue.number,
          name: label.name,
        });
      }
    }

    return;
  }

  await setPriceLabel(context, labels, config);
}

async function setPriceLabel(context: Context, issueLabels: Label[], config: AssistivePricingSettings) {
  const logger = context.logger;
  const labelNames = issueLabels.map((i) => i.name);

  const recognizedLabels = getRecognizedLabels(issueLabels, config);

  if (!recognizedLabels.time.length || !recognizedLabels.priority.length) {
    logger.error("No recognized labels to calculate price");
    await clearAllPriceLabelsOnIssue(context);
    return;
  }

  const minLabels = getMinLabels(recognizedLabels);

  if (!minLabels.time || !minLabels.priority) {
    logger.error("No label to calculate price");
    return;
  }

  const targetPriceLabel = setPrice(context, minLabels.time, minLabels.priority);

  if (targetPriceLabel) {
    await handleTargetPriceLabel(context, targetPriceLabel, labelNames);
  } else {
    await clearAllPriceLabelsOnIssue(context);
    logger.info(`Skipping action...`);
  }
}

function getRecognizedLabels(labels: Label[], settings: AssistivePricingSettings) {
  function isRecognizedLabel(label: Label, configLabels: string[]) {
    return (typeof label === "string" || typeof label === "object") && configLabels.some((configLabel) => configLabel === label.name);
  }

  const recognizedTimeLabels: Label[] = labels.filter((label: Label) => isRecognizedLabel(label, settings.labels.time));

  const recognizedPriorityLabels: Label[] = labels.filter((label: Label) => isRecognizedLabel(label, settings.labels.priority));

  return { time: recognizedTimeLabels, priority: recognizedPriorityLabels };
}

function getMinLabels(recognizedLabels: { time: Label[]; priority: Label[] }) {
  const minTimeLabel = sortLabelsByValue(recognizedLabels.time).shift();
  const minPriorityLabel = sortLabelsByValue(recognizedLabels.priority).shift();

  return { time: minTimeLabel, priority: minPriorityLabel };
}

async function handleTargetPriceLabel(context: Context, targetPriceLabel: string, labelNames: string[]) {
  const _targetPriceLabel = labelNames.find((name) => name.includes("Price") && name.includes(targetPriceLabel));

  if (_targetPriceLabel) {
    await handleExistingPriceLabel(context, targetPriceLabel);
  } else {
    const allLabels = await listLabelsForRepo(context);
    if (allLabels.filter((i) => i.name.includes(targetPriceLabel)).length === 0) {
      await createLabel(context, targetPriceLabel, "price");
    }
    await addPriceLabelToIssue(context, targetPriceLabel);
  }
}

async function handleExistingPriceLabel(context: Context, targetPriceLabel: string) {
  const logger = context.logger;
  let labeledEvents = await getAllLabeledEvents(context);
  if (!labeledEvents) return logger.error("No labeled events found");

  labeledEvents = labeledEvents.filter((event) => "label" in event && event.label.name.includes("Price"));
  if (!labeledEvents.length) return logger.error("No price labeled events found");

  if (labeledEvents[labeledEvents.length - 1].actor?.type == "User") {
    logger.info(`Skipping... already exists`);
  } else {
    await addPriceLabelToIssue(context, targetPriceLabel);
  }
}

async function addPriceLabelToIssue(context: Context, targetPriceLabel: string) {
  await clearAllPriceLabelsOnIssue(context);
  await addLabelToIssue(context, targetPriceLabel);
}

export async function labelExists(context: Context, name: string): Promise<boolean> {
  const payload = context.payload;
  try {
    await context.octokit.rest.issues.getLabel({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      name,
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function getAllLabeledEvents(context: Context) {
  const events = await getAllIssueEvents(context);
  if (!events) return null;
  return events.filter((event) => event.event === "labeled");
}

async function getAllIssueEvents(context: Context) {
  if (!("issue" in context.payload) || !context.payload.issue) {
    context.logger.debug("Not an issue event");
    return;
  }

  try {
    return await context.octokit.paginate(context.octokit.issues.listEvents, {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: context.payload.issue.number,
      per_page: 100,
    });
  } catch (err: unknown) {
    context.logger.fatal("Failed to fetch lists of events", err);
    return [];
  }
}
