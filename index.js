const CORE = require('@actions/core');
const YAML = require('yaml');
const fs = require('fs');
const { exec } = require("child_process");
const { ECRClient, BatchDeleteImageCommand } = require("@aws-sdk/client-ecr");
const { readReferenceTag } = require("./referenceTags");

// inputs
const env_key = CORE.getInput('env-key');
var local_image = CORE.getInput('local-image');
const remote_image = CORE.getInput('remote-image');
const extra_tags = readExtraTags();

//global vars
const ActionTriggersEnum = Object.freeze({"build":1, "retag":2});
var actionTrigger = ActionTriggersEnum.build;

function readExtraTags() {
	const input = CORE.getInput('extra-tags');
	let obj = {};
	if (input) {
		const KVPs = input.split(',');
		KVPs.forEach(function(kvp) {
			const parts = kvp.split('=');
			if (parts.length != 2) {
				throw 'malformed input: extra-tags.'
			}
			const key = parts[0];
			const value = parts[1];
			if (key in obj) {
				throw `extra-tags has duplicate key: ${key}.`
			}
			obj[key] = value;
		});
	}
	return obj;
}

// calc versions for "Semantic Versioning"
// Example: version 1.2.6 => v1.2.6, v1.2, v1
function calc_sm_versions(version) {

	const trimVPrefix_re = /^[vV]?(?<cleaned>[\d]+([\d.]*\d+)?)$/;
	const findVersion_re = /^[\d]+[\d.]*(?=[.]\d+$)/;

	var versionCleaned = version.match(trimVPrefix_re);
	if (versionCleaned)
		version = versionCleaned.groups.cleaned;
	else
		throw `malformed version: ${version}.`

	let sm_versions = [];
	sm_versions.push(`v${version}`);

	while ((re_matches = findVersion_re.exec(version)) !== null) {
		let foundVersion = re_matches[0];
		sm_versions.push(`v${foundVersion}`);
		version = foundVersion;
	}

	return sm_versions;
}

async function pushToECR(target) {
  try {
	
	const registry = target['ecr-registry'];
	const repository = target['ecr-repository'];
	let tag = target['ecr-tag'];
	const forcePush = target['force-push'];
	const continueOnError = target['continue-on-error'];
	const onlyOnBuild = target['only-on-build'];
	const semanticVersioning = target['semantic-versioning'];
	let sm_versions = null;
	let error = false;
	
	if (actionTrigger !== ActionTriggersEnum.build && onlyOnBuild !== undefined && onlyOnBuild !== true && onlyOnBuild !== false) {
		CORE.setFailed(`ECR push target has invalid value for only-on-build. Either omit this property or set it to one of the valid values: [true, false]`);
		return;
	}
	if (onlyOnBuild && actionTrigger !== ActionTriggersEnum.build) {
		console.log(`skip ECR push target '${registry}/${repository}:${tag}': tag is set to only-on-build`);
		return;
	}
	
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
	if (tag.startsWith('$$')) {
		try {
			tag = readReferenceTag(tag, target);
		} catch (reference_tags_error) {
			handleError(reference_tags_error, continueOnError !== false)
			error = true;			
		}
	}
	if (forcePush !== undefined && forcePush !== true && forcePush !== false) {
		CORE.setFailed(`ECR push target has invalid value for force-push. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (continueOnError !== undefined && continueOnError !== true && continueOnError !== false) {
		CORE.setFailed(`ECR push target has invalid value for continue-on-error. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (semanticVersioning !== undefined && semanticVersioning !== true && semanticVersioning !== false) {
		CORE.setFailed(`ECR push target has invalid value for semantic-versioning. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (error) { return; }
	  
	if (semanticVersioning) {
		try {
			sm_versions = calc_sm_versions(tag);
		} catch (sm_error) {
			CORE.setFailed(`Error in calc_sm_versions().\n${sm_error}`);
			return;
		}
		if (sm_versions == null || !(sm_versions.length > 0)) {
			CORE.setFailed(`Failed to calc_sm_versions(). got 0 results based on input ${tag} and 'ecr-tag' property ${target['ecr-tag']}`);
			return;
		}
	}
	
	let targetProperties = {
	  registry,
	  repository,
	  tag,
	  forcePush,
	  continueOnError
	}

	if (semanticVersioning) {
		for (const version of sm_versions) {
			targetProperties.tag = version;
			await pushTag(targetProperties);
			
			// forcePush = true (for derived versions)
			targetProperties = { ...targetProperties };
			targetProperties.forcePush = true;
		}
		return;
	}

	await pushTag(targetProperties);
  }
  catch (error) {
    CORE.setFailed(error);
  }
}

async function pushTag(targetProps) {
  try {
	  const newImage = `'${targetProps.registry}/${targetProps.repository}:${targetProps.tag}'`;
	
	try {
		await execAsync(`docker image tag ${local_image} ${newImage}`);
		console.log(`tag ${newImage}: success`);
	}
	catch (error) {
		const errorMessage = `tag ${newImage}: ${error}`;
		handleError(errorMessage, targetProps.continueOnError);
		return;
	}
	
	if (targetProps.forcePush) {
		const ecr_client = new ECRClient();
		const ecr_response = await ecr_client.send(new BatchDeleteImageCommand({
			repositoryName: targetProps.repository,
			imageIds: [{ imageTag: targetProps.tag }]
		}));
		if (ecr_response && ecr_response.failures && ecr_response.failures.length > 0) {
			let error = false;
			ecr_response.failures.forEach(function(failure) {
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
	
	try {
		await execAsync(`docker image push ${newImage}`);
		console.log(`push ${newImage}: success`);
	}
	catch (error) {
		const errorMessage = `push ${newImage}: ${error}`;
		handleError(errorMessage, targetProps.continueOnError);
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

function handleError(errorMessage, continueOnError) {
	if (continueOnError) { console.warn(errorMessage); }
	else { CORE.setFailed(errorMessage); }
}

// image_to_retag must be a remote image
async function prepareForRetag(image_to_retag) {
	try { await execAsync(`docker image pull ${image_to_retag}`); }
	catch { throw `failed to pull docker image: ${image_to_retag}`; }
	console.log(`pulled remote image ${image_to_retag}: success`);

	const local_image_temp = "docker_image:temp";
	try { await execAsync(`docker image tag ${image_to_retag} ${local_image_temp}`); }
	catch (error) { throw `tag ${local_image_temp}: ${error}`; }

	local_image = local_image_temp;
	actionTrigger = ActionTriggersEnum.retag;
}

async function prepareToRetagUnique(publishTargets) {
	let uniqueTargets = publishTargets.filter(target => target['unique-id'] === true);
	if (uniqueTargets.length > 0) {
		if (uniqueTargets.length > 1) {
			throw `there are ${uniqueTargets.length} unique targets. max number of allowed unique targets is 1.`
				+ " Thus, it can't be a hard-coded value. please fix your '.automation/deployment_envs.yaml' file.";
		}

		const unique_target = uniqueTargets[0];
		let unique_tag = unique_target['ecr-tag'];

		if (!unique_tag.startsWith('$$')) {
			throw "unique-id must be an idempotent tag that uniquely identifies the specific image, like a commit hash."
				+ " Thus, it can't be a hard-coded value. please fix your '.automation/deployment_envs.yaml' file.";
		}

		// read unique tag, download remote image and set (actionTrigger = retag)
		unique_tag = readReferenceTag(unique_tag, unique_target);
		const remote_image_to_retag = `'${unique_target['ecr-registry']}/${unique_target['ecr-repository']}:${unique_tag}'`;
		try {
			await prepareForRetag(remote_image_to_retag);
		} catch {
			console.log("didn't find remote image to retag based on the unique-id. continue normally with (actionTrigger = build).");
			return;
		}

		// remove target
		const target_index = publishTargets.indexOf(unique_target);
		if (target_index >= 0) {
			publishTargets.splice(target_index, 1);
		}
		else {
			throw "failed to remove the unique target from the publishTargets array."
				+ " Please debug and fix.";
		}
	}
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
		await prepareForRetag(remote_image);
	}
	
	const file = fs.readFileSync('.automation/deployment_envs.yaml', 'utf8');
	const yamlObj = YAML.parse(file);
	const envs = yamlObj['envs'];
	const requested_env = envs[env_key];
	if (!requested_env) {
		CORE.setFailed(`requested env (${env_key}) is missing`);
		return;
	}
	
	const publishTargets = requested_env['publish-to'];
	if (publishTargets && publishTargets.length > 0) {
		console.log(`${env_key} has ${publishTargets.length} ECR publish targets`);

		// handle unique-id
		if (actionTrigger != ActionTriggersEnum.retag) {
			await prepareToRetagUnique(publishTargets)
		}

		publishTargets.forEach(pushToECR);
	}
  }
  catch (error) {
    CORE.setFailed(error);
  }
}

main();