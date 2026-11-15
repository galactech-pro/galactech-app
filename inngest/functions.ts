import { wf001NewLeadWelcome, wf002FollowUp, wf003HotLead, wf004ReplyHandler } from "./wf-leads";
import { wf005TrialEnding, wf007PaymentSuccess, wf008ChurnPrevention, wf009WeeklyReport, wf010SubClient } from "./wf-lifecycle";
import { wf006CallPostProcessing, callRetry, scheduledCalls } from "./wf-calls";
import { campaignSend } from "./campaign-send";
import { reconcile } from "./reconcile";
import { automationEngine, dispatchNewContact, dispatchTagAdded, dispatchScoreChanged, dispatchReply } from "./automation-engine";

import { kbAutoReply, kbResync } from "./knowledge";

export { inngest } from "@/lib/inngest";

export const functions = [
  wf001NewLeadWelcome,
  wf002FollowUp,
  wf003HotLead,
  wf004ReplyHandler,
  wf005TrialEnding,
  wf006CallPostProcessing,
  wf007PaymentSuccess,
  wf008ChurnPrevention,
  wf009WeeklyReport,
  wf010SubClient,
  campaignSend,
  reconcile,
  callRetry,
  scheduledCalls,
  automationEngine,
  dispatchNewContact,
  dispatchTagAdded,
  dispatchScoreChanged,
  dispatchReply,
  kbAutoReply,
  kbResync,
];
