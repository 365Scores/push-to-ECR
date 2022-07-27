const CORE = require('@actions/core');
const YAML = require('yaml');
const fs = require('fs');
const { exec } = require("child_process");
const { ECRClient, BatchDeleteImageCommand } = require("@aws-sdk/client-ecr");
const { readReservedTag } = require("./reservedTags");

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
	if (tag.startsWith('$$$')) {
		const reserved_tag = tag.substring(3);
		try {
			tag = readReservedTag(reserved_tag);
		} catch (reserved_tags_error) {
			const errorMessage = `Failed to process reserved tag ${reserved_tag} of target ${JSON.stringify(target, null, 2)}. Error:\n${reserved_tags_error}`;
			handleError(errorMessage, continueOnError !== false)
			error = true;			
		}
	}
	else if (tag.startsWith('$$')) {
		const input_tag = extra_tags[tag.substring(2)];
		if (input_tag) {
			tag = input_tag;
		}
		else {
			const errorMessage = `warning: ECR push target is missing ecr-tag. extra-tags is missing tag ${tag.substring(2)}.`;
			handleError(errorMessage, continueOnError !== false)
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
	if (semanticVersioning) {
		try {
			sm_versions = calc_sm_versions(tag);
		} catch (sm_error) {
			CORE.setFailed(`Error in calc_sm_versions().\n${sm_error}`);
			error = true;
		}
		if (sm_versions == null || !(sm_versions.length > 0)) {
			CORE.setFailed(`Failed to calc_sm_versions(). got 0 results based on input ${tag} and 'ecr-tag' property ${target['ecr-tag']}`);
			error = true;
		}
	}
	if (error) { return; }
	
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
    if (continueOnError) { console.error(errorMessage); }
	else { CORE.setFailed(errorMessage); }
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
		publishTargets.forEach(pushToECR);
	}
  }
  catch (error) {
    CORE.setFailed(error);
  }
}

main();