import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestError } from "@octokit/request-error";
import { Context } from "@actions/github/lib/context";
import { GitHub } from "@actions/github/lib/utils";

export async function approve(
  token: string,
  context: Context,
  prNumber?: number,
  reviewMessage?: string
) {
  if (!prNumber) {
    prNumber = context.payload.pull_request?.number;
  }

  if (!prNumber) {
    core.setFailed(
      "Event payload missing `pull_request` key, and no `pull-request-number` provided as input." +
        "Make sure you're triggering this action on the `pull_request` or `pull_request_target` events."
    );
    return;
  }

  const client = github.getOctokit(token);

  try {
    let { owner, repo } = context.repo;
    core.info(`${context.repo}`);
    repo = 'helm-charts';

    core.info(`Fetching user, pull request information, and existing reviews`);
    const [login, { data: pr }, { data: reviews }] = await Promise.all([
      getLoginForToken(client),
      client.rest.pulls.get({ owner, repo, pull_number: prNumber }),
      client.rest.pulls.listReviews({ owner, repo, pull_number: prNumber }),
    ]);

    core.info(`Current user is ${login}`);

    const prHead = pr.head.sha;
    core.info(`Commit SHA is ${prHead}`);

    const alreadyReviewed = reviews.some(
      ({ user, commit_id, state }) =>
        user?.login === login && commit_id == prHead && state === "APPROVED"
    );
    const outstandingReviewRequest = pr.requested_reviewers?.some(
      (reviewer) => reviewer.login == login
    );
    if (alreadyReviewed && !outstandingReviewRequest) {
      core.info(
        `Current user already approved pull request #${prNumber}, nothing to do`
      );
      return;
    }

    core.info(
      `Pull request #${prNumber} has not been approved yet, creating approving review`
    );
    await client.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: 'helm-charts',
      pull_number: prNumber,
      body: reviewMessage,
      event: "APPROVE",
    });
    core.info(`Approved pull request #${prNumber}`);
  } catch (error) {
    if (error instanceof RequestError) {
      switch (error.status) {
        case 401:
          core.setFailed(
            `${error.message}. Please check that the \`github-token\` input ` +
              "parameter is set correctly."
          );
          break;
        case 403:
          core.setFailed(
            `${error.message}. In some cases, the GitHub token used for actions triggered ` +
              "from `pull_request` events are read-only, which can cause this problem. " +
              "Switching to the `pull_request_target` event typically resolves this issue."
          );
          break;
        case 404:
          core.setFailed(
            `${error.message}. This typically means the token you're using doesn't have ` +
              "access to this repository. Use the built-in `${{ secrets.GITHUB_TOKEN }}` token " +
              "or review the scopes assigned to your personal access token."
          );
          break;
        case 422:
          core.setFailed(
            `${error.message}. This typically happens when you try to approve the pull ` +
              "request with the same user account that created the pull request. Try using " +
              "the built-in `${{ secrets.GITHUB_TOKEN }}` token, or if you're using a personal " +
              "access token, use one that belongs to a dedicated bot account."
          );
          break;
        default:
          core.setFailed(`Error (code ${error.status}): ${error.message}`);
      }
      return;
    }

    if (error instanceof Error) {
      core.setFailed(error);
    } else {
      core.setFailed("Unknown error");
    }
    return;
  }
}

async function getLoginForToken(
  client: InstanceType<typeof GitHub>
): Promise<string> {
  try {
    const { data: user } = await client.rest.users.getAuthenticated();
    return user.login;
  } catch (error) {
    if (error instanceof RequestError) {
      // If you use the GITHUB_TOKEN provided by GitHub Actions to fetch the current user
      // you get a 403. For now we'll assume any 403 means this is an Actions token.
      if (error.status === 403) {
        return "github-actions[bot]";
      }
    }
    throw error;
  }
}
