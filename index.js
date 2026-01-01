const CORE = require('@actions/core');
const YAML = require('yaml');
const fs = require('fs');
const { exec } = require("child_process");
const { ECRClient, BatchDeleteImageCommand, DescribeImagesCommand } = require("@aws-sdk/client-ecr");

// inputs
var local_image = CORE.getInput('local-image');
const remote_image = CORE.getInput('remote-image');
const ecr_repository = CORE.getInput('ecr-repository');
const registry_id = CORE.getInput('registry-id');
const extra_tags = readExtraTags();

//global vars
const ActionTriggersEnum = Object.freeze({ "build": 1, "retag": 2 });
var actionTrigger = ActionTriggersEnum.build;

function readExtraTags() {
	const input = CORE.getInput('extra-tags');
	let tags = [];
	if (input) {
		tags = input.split(',')           	// 1. Split by comma (prevents commas inside items)
			.map(tag => tag.trim())       	// 2. Remove spaces at beginning/end
			.filter(tag => tag.length > 0); // 3. Remove empty strings/spaces-only items
	}

	return tags.length > 0 ? tags : CORE.setFailed('No Extra Tags were provided');
}

async function isRepositoryImmutable(repository_name) {
	try {
		const repo_name = repository_name

		// Construct the full command string
		// Note: We wrap repoName in quotes to be safe against spaces
		const command = `aws ecr describe-repositories --repository-names "${repo_name}" --query 'repositories[0].imageTagMutability' --output text`;

		// Use your helper function
		const stdout = await execAsync(command);

		// Process the result
		const mutability = stdout.trim();

		console.log(`Repository '${repo_name}' is: ${mutability}`);

		// Write to GITHUB_ENV
		fs.appendFileSync(process.env.GITHUB_ENV, `MUTABILITY=${mutability}\n`);
		return mutability == "IMMUTABLE"

	} catch (error) {
		// Your helper rejects on error OR stderr, so we catch both here
		CORE.setFailed(`Failed to check immutability: ${error}`);
		return;
	}
}

/**
 * Checks if a specific tag exists in the ECR repository using AWS SDK v3.
 * * @param {string} repositoryName - The name of the ECR repository.
 * @param {string} tag - The image tag to check.
 * @returns {Promise<boolean>} - Returns true if the tag exists, false otherwise.
 */
async function isTagExist(ecr_client, repositoryName, tag) {
	// Ideally, create the client once globally to reuse connections
	const client = ecr_client

	const command = new DescribeImagesCommand({
		repositoryName: repositoryName,
		imageIds: [{ imageTag: tag }]
	});

	try {
		await client.send(command);
		console.log(`Tag '${tag}' found in repo '${repositoryName}'.`);
		return true;
	} catch (error) {
		// AWS SDK v3 throws this specific error name when an image isn't found
		if (error.name === 'ImageNotFoundException') {
			console.log(`Tag '${tag}' NOT found in repo '${repositoryName}'.`);
			return false;
		}

		// Critical: Re-throw unexpected errors (AccessDenied, Throttling, etc.)
		console.error(`[ERROR] Failed to check tag existence: ${error.message}`);
		throw error;
	}
}

async function pushToECR(tag_name, ecr_repo, is_repository_immutable) {
	try {

		const registry = registry_id;
		const repository = ecr_repo
		let tag = tag_name;
		const forcePush = force_push
		const is_repo_immutable = is_repository_immutable
		let error = false;

		if (!registry) {
			CORE.setFailed(`ECR push target is missing ecr-registry`);
			error = true;
		}
		if (!repository) {
			CORE.setFailed(`ECR push target is missing ecr-repository`);
			error = true;
		}
		if (!tag) {
			CORE.setFailed(`ECR push target is missing ecr-tag`);
			error = true;
		}
		if (forcePush !== undefined && forcePush !== true && forcePush !== false) {
			CORE.setFailed(`ECR push target has invalid value for force-push. Either omit this property or set it to one of the valid values: [true, false]`);
			error = true;
		}
		if (error) { return; }

		const newImage = `'${registry}/${repository}:${tag}'`;

		try {
			await execAsync(`docker image tag ${local_image} ${newImage}`);
			console.log(`tag ${newImage}: success`);
		}
		catch (error) {
			const errorMessage = `tag ${newImage}: ${error}`;
			if (continueOnError) { console.error(errorMessage); }
			else { CORE.setFailed(errorMessage); }
			return;
		}

		if (is_repo_immutable) {
			console.log(`Force Pushing: ${tag}`)
			const ecr_client = new ECRClient();
			is_tag_exist = await isTagExist(ecr_client, repository, tag)
			if (is_tag_exist) {
				const ecr_response = await ecr_client.send(new BatchDeleteImageCommand({
					repositoryName: repository,
					imageIds: [{ imageTag: tag }]
				}));
				if (ecr_response && ecr_response.failures && ecr_response.failures.length > 0) {
					let error = false;
					ecr_response.failures.forEach(function (failure) {
						if (failure.failureCode != 'ImageNotFound') {
							error = true;
						}
					});
					if (error) {
						CORE.setFailed(`delete existing ECR tag ${newImage}: ${JSON.stringify(ecr_response, null, 2)}`);
						return;
					}
				}
				console.log(`ECR delete tag ${newImage} - Success`);
				//console.log(ecr_response);
			}
		}

		try {
			await execAsync(`docker image push ${newImage}`);
			console.log(`push ${newImage}: success`);
		}
		catch (error) {
			const errorMessage = `push ${newImage}: ${error}`;
			if (continueOnError) { console.error(errorMessage); }
			else { CORE.setFailed(errorMessage); }
			return;
		}
	}
	catch (error) {
		CORE.setFailed(error);
	}
}

function execAsync(command) {
	return new Promise((resolve, reject) => {
		exec(command, (error, stdout, stderr) => {
			if (error) { reject(error); }
			else if (stderr) { reject(stderr); }
			else { resolve(stdout); }
		});
	});
}

async function main() {
	try {

		//console.log(`env_key ${env_key}, spot_io_token ${spot_io_token}`);

		if (local_image && remote_image) {
			CORE.setFailed("this action requires only 1 of the following inputs: local-image, remote-image");
			return;
		}

		if (!local_image && !remote_image) {
			CORE.setFailed("this action requires 1 of the following inputs: local-image, remote-image");
			return;
		}

		if (remote_image) {
			actionTrigger = ActionTriggersEnum.retag;
			local_image = "docker_image:temp";

			try { await execAsync(`docker image pull ${remote_image}`); }
			catch { CORE.setFailed(`failed to pull docker image: ${remote_image}`); return; }
			console.log(`pulled remote image ${remote_image}: success`);

			try { await execAsync(`docker image tag ${remote_image} ${local_image}`); }
			catch (error) { CORE.setFailed(`tag ${local_image}: ${error}`); return; }
		}


		const is_repo_immutable = await isRepositoryImmutable(ecr_repository)
		console.log(`Is repo immutable: ${is_repo_immutable}`)
		if (is_repo_immutable !== undefined) {
			for (const tag of extra_tags) {
				await pushToECR(tag, ecr_repository, is_repo_immutable);
			}
		} else {
			throw new Error("Error when getting repo immutablity")
		}
	}
	catch (error) {
		CORE.setFailed(error.message);
	}
}

main();