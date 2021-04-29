/* eslint-disable no-param-reassign, no-shadow, no-unused-vars, no-continue */

import logger from '../../utils/logger.mjs';
import { traverse } from '../../traverse/traverse.mjs';
import buildNode from '../../types/orchestration-types.mjs';
import { buildPrivateStateNode } from '../../boilerplate/orchestration/javascript/nodes/boilerplate-generator.mjs';

/**
 * @desc:
 * Visitor transforms a `.zol` AST into a `.js` AST
 * NB: the resulting `.js` AST is custom, and can only be interpreted by this
 * repo's code generator. JS compilers will not be able to interpret this
 * AST.
 */

export default {
  ContractDefinition: {
    enter(path, state) {
      const { node, parent, scope } = path;
      node._newASTPointer = parent._newASTPointer;

      const contractName = `${node.name}Shield`;
      if (scope.indicators.zkSnarkVerificationRequired) {
        const newNode = buildNode('File', {
          fileName: 'test',
          fileExtension: '.mjs',
          nodes: [
            buildNode('IntegrationTestBoilerplate', {
              contractName,
              contractImports: state.contractImports,
            }),
          ],
        });
        node._newASTPointer.push(newNode);
      }
      const newNode = buildNode('SetupCommonFilesBoilerplate', {
        contractName,
        contractImports: state.contractImports,
      });
      node._newASTPointer.push(newNode);
      if (scope.indicators.newCommitmentsRequired) {
        const newNode = buildNode('EditableCommitmentCommonFilesBoilerplate');
        node._newASTPointer.push(newNode);
      }
    },

    exit(path, state) {
      const { node, parent, scope } = path;
      for (const file of node._newASTPointer) {
        if (file.nodeType === 'SetupCommonFilesBoilerplate') {
          file.constructorParams = state.constructorParams;
          file.contractImports = state.contractImports;
        }
        if (file.nodes?.[0].nodeType === 'IntegrationTestBoilerplate') {
          file.nodes[0].constructorParams = state.constructorParams;
          file.nodes[0].contractImports = state.contractImports;
        }
      }
    },
  },

  ImportDirective: {
    enter(path, state) {
      const { node, parent } = path;
      state.contractImports ??= [];
      state.contractImports.push({
        absolutePath: node.absolutePath,
        file: node.file,
      });
      // we assume all import statements come before all functions
    },

    exit(path) {},
  },

  FunctionDefinition: {
    enter(path, state) {
      const { node, parent, scope } = path;

      let newFile = false;
      if (scope.modifiesSecretState()) {
        newFile = true;
        const contractName = `${parent.name}Shield`;
        const newNode = buildNode('File', {
          fileName: node.name, // the name of this function
          fileExtension: '.mjs',
          nodes: [
            buildNode('Imports'),
            buildNode('FunctionDefinition', { name: node.name }),
          ],
        });
        node._newASTPointer = newNode.nodes[1]; // eslint-disable-line prefer-destructuring
        parent._newASTPointer.push(newNode);
        for (const file of parent._newASTPointer) {
          if (file.nodes?.[0].nodeType === 'IntegrationTestBoilerplate') {
            file.nodes[0].functions.push(
              buildNode('IntegrationTestFunction', {
                name: node.name,
                parameters: [],
              }),
            );
          }
        }
      } else {
        state.skipSubNodes = true;
        if (node.kind === 'constructor') {
          state.constructorParams ??= [];
          for (const param of node.parameters.parameters) {
            state.constructorParams.push(
              buildNode('VariableDeclaration', {
                name: param.name,
                type: param.typeName.name,
                isSecret: param.isSecret,
                modifiesSecretState: false,
              }),
            );
          }
        }
      }
    },

    exit(path, state) {
      const { node, parent, scope } = path;
      const initialiseOrchestrationBoilerplateNodes = fnIndicator => {
        const newNodes = {};
        const contractName = `${parent.name}Shield`;
        if (fnIndicator.initialisationRequired)
          newNodes.initialisePreimageNode = buildNode('InitialisePreimage');
        if (fnIndicator.oldCommitmentAccessRequired)
          newNodes.readPreimageNode = buildNode('ReadPreimage', {
            contractName,
            onChainKeyRegistry: fnIndicator.onChainKeyRegistry,
          });
        if (fnIndicator.nullifiersRequired) {
          newNodes.membershipWitnessNode = buildNode('MembershipWitness', {
            contractName,
          });
          newNodes.calculateNullifierNode = buildNode('CalculateNullifier');
        }
        if (fnIndicator.newCommitmentsRequired)
          newNodes.calculateCommitmentNode = buildNode('CalculateCommitment');
        newNodes.generateProofNode = buildNode('GenerateProof', {
          circuitName: node.name,
        });
        newNodes.sendTransactionNode = buildNode('SendTransaction', {
          functionName: node.name,
          contractName,
        });
        newNodes.writePreimageNode = buildNode('WritePreimage', {
          contractName,
          onChainKeyRegistry: fnIndicator.onChainKeyRegistry,
        });
        return newNodes;
      };
      // By this point, we've added a corresponding FunctionDefinition node to the newAST, with the same nodes as the original Solidity function, with some renaming here and there, and stripping out unused data from the oldAST.
      const functionIndicator = scope.indicators;
      let thisIntegrationTestFunction = {};
      for (const file of parent._newASTPointer) {
        if (file.nodes?.[0].nodeType === 'IntegrationTestBoilerplate') {
          for (const fn of file.nodes[0].functions) {
            if (fn.name === node.name) thisIntegrationTestFunction = fn;
          }
        }
        if (file.nodeType === 'SetupCommonFilesBoilerplate') {
          file.functionNames.push(node.name);
        }
      }
      thisIntegrationTestFunction.parameters = node._newASTPointer.parameters;
      if (
        functionIndicator.newCommitmentsRequired &&
        scope.modifiesSecretState()
      ) {
        const newNodes = initialiseOrchestrationBoilerplateNodes(
          functionIndicator,
        );
        // 1 - InitialisePreimage - whole states - per state
        // 2 - ReadPreimage - oldCommitmentAccessRequired - per state
        // 3 - MembershipWitness - nullifiersRequired - per state
        // 4 - CalculateNullifier - nullifiersRequired - per state
        // 5 - CalculateCommitment - newCommitmentRequired - per state
        // 6 - GenerateProof - all - per function
        // 7 - SendTransaction - all - per function
        // 8 - WritePreimage - all - per state
        const modifiedStateVariableIndicators = [];
        for (const [id, stateVarIndicator] of Object.entries(
          functionIndicator,
        )) {
          if (!stateVarIndicator?.isSecret) continue;
          if (stateVarIndicator.isMapping) {
            for (const [, mappingKey] of Object.entries(
              stateVarIndicator.mappingKeys,
            )) {
              modifiedStateVariableIndicators.push(mappingKey);
            }
          } else {
            modifiedStateVariableIndicators.push(stateVarIndicator);
          }
        }

        for (const stateVarIndicator of modifiedStateVariableIndicators) {
          let { name, id } = stateVarIndicator;
          let incrementsString = '';
          if (stateVarIndicator.isIncremented) {
            stateVarIndicator.increments?.forEach(inc => {
              incrementsString += inc.name
                ? `+ ${inc.name} `
                : `+ ${inc.value} `;
            });
            stateVarIndicator.decrements?.forEach(dec => {
              incrementsString += dec.name
                ? `- ${dec.name} `
                : `- ${dec.value} `;
            });
          }

          if (stateVarIndicator.isDecremented) {
            // TODO refactor
            node._newASTPointer.decrementedSecretStates ??= [];
            node._newASTPointer.decrementedSecretStates.push(name);
            node._newASTPointer.decrementsSecretState = true;
          }
          const modifiedStateVariableNode = buildNode('VariableDeclaration', {
            name,
            isSecret: stateVarIndicator.isSecret,
            type: stateVarIndicator.node.typeDescriptions.typeString,
          });
          node._newASTPointer.parameters.modifiedStateVariables.push(
            modifiedStateVariableNode,
          );
          // thisIntegrationTestFunction.parameters.modifiedStateVariables.push(
          //   modifiedStateVariableNode,
          // );

          if (stateVarIndicator.referencedKeyName) {
            id = [id, stateVarIndicator.referencedKeyName];
            name = name.replace('[', '_').replace(']', '');
          }
          if (stateVarIndicator.isWhole) {
            newNodes.initialisePreimageNode.privateStates[name] = {
              privateStateName: name,
            };
            newNodes.readPreimageNode.privateStates[
              name
            ] = buildPrivateStateNode('ReadPreimage', {
              id,
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
          }
          if (stateVarIndicator.isNullified) {
            newNodes.membershipWitnessNode.privateStates[
              name
            ] = buildPrivateStateNode('MembershipWitness', {
              privateStateName: name,
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
            newNodes.calculateNullifierNode.privateStates[
              name
            ] = buildPrivateStateNode('CalculateNullifier', {
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
          }
          if (stateVarIndicator.isModified) {
            newNodes.calculateCommitmentNode.privateStates[
              name
            ] = buildPrivateStateNode('CalculateCommitment', {
              privateStateName: name,
              id,
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
            newNodes.generateProofNode.privateStates[
              name
            ] = buildPrivateStateNode('GenerateProof', {
              privateStateName: name,
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
            newNodes.generateProofNode.parameters.push(name);
            newNodes.sendTransactionNode.privateStates[
              name
            ] = buildPrivateStateNode('SendTransaction', {
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
            newNodes.writePreimageNode.privateStates[
              name
            ] = buildPrivateStateNode('WritePreimage', {
              id,
              increment: incrementsString,
              indicator: stateVarIndicator,
            });
          }
        }
        // this adds other values we need in the circuit
        for (const param of node._newASTPointer.parameters.parameters) {
          if (param.isPrivate || param.isSecret || param.modifiesSecretState)
            newNodes.generateProofNode.parameters.push(param.name);
        }
        // this adds other values we need in the tx
        for (const param of node.parameters.parameters) {
          if (!param.isSecret)
            newNodes.sendTransactionNode.publicInputs.push(param.name);
        }

        // the newNodes array is already ordered, however we need the initialisePreimageNode before any copied over statements
        if (newNodes.initialisePreimageNode)
          node._newASTPointer.body.statements.splice(
            0,
            0,
            newNodes.initialisePreimageNode,
          );
        // 1 - InitialisePreimage - whole states - per state
        // 2 - ReadPreimage - oldCommitmentAccessRequired - per state
        // 3 - MembershipWitness - nullifiersRequired - per state
        // 4 - CalculateNullifier - nullifiersRequired - per state
        // 5 - CalculateCommitment - newCommitmentRequired - per state
        // 6 - GenerateProof - all - per function
        // 7 - SendTransaction - all - per function
        // 8 - WritePreimage - all - per state
        node._newASTPointer.body.statements.push(newNodes.readPreimageNode);
        node._newASTPointer.body.statements.push(
          newNodes.membershipWitnessNode,
        );
        node._newASTPointer.body.statements.push(
          newNodes.calculateNullifierNode,
        );
        node._newASTPointer.body.statements.push(
          newNodes.calculateCommitmentNode,
        );
        node._newASTPointer.body.statements.push(newNodes.generateProofNode);
        node._newASTPointer.body.statements.push(newNodes.sendTransactionNode);
        node._newASTPointer.body.statements.push(newNodes.writePreimageNode);
      }
    },
  },

  ParameterList: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType);
      node._newASTPointer = newNode.parameters;
      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path, state) {
      const { node, parent } = path;
    },
  },

  Block: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType);
      node._newASTPointer = newNode.statements;
      parent._newASTPointer.body = newNode;
    },

    exit(path) {},
  },

  VariableDeclarationStatement: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType);
      node._newASTPointer = newNode;
      parent._newASTPointer.push(newNode);
    },

    exit(path) {},
  },

  BinaryOperation: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType);
      node._newASTPointer = newNode;
      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  Assignment: {
    enter(path, state) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType, { operator: node.operator });
      node._newASTPointer = newNode;
      if (parent._newASTPointer.nodeType === 'VariableDeclarationStatement') {
        parent._newASTPointer.initialValue = newNode;
      } else {
        parent._newASTPointer.expression = newNode;
      }
    },

    exit(path, state) {},
  },

  ExpressionStatement: {
    enter(path, state) {
      // TODO refactor
      // We sometimes do need to copy over statements if we need to work out the new commitment value
      // e.g. secret x; x = y +2 => we need to copy over this line to the node file to construct the new commitment
      const { node, parent, scope } = path;
      let isMapping;
      // ExpressionStatements can contain an Assignment node.
      if (node.expression.nodeType === 'Assignment') {
        const assignmentNode = node.expression;
        const { leftHandSide: lhs } = node.expression;
        const indicator = scope.getReferencedIndicator(lhs, true);

        // We should only replace the _first_ assignment to this node. Let's look at the scope's modifiedBindings for any prior modifications to this binding:
        // if its secret and this is the first assigment, we add a vardec
        if (
          indicator.modifyingPaths[0].node.id === lhs.id &&
          indicator.isSecret &&
          indicator.isWhole
        ) {
          let accessed = false;
          indicator.accessedPaths?.forEach(obj => {
            if (obj.node.id === lhs.id) accessed = true;
          });

          const newNode = buildNode('VariableDeclarationStatement', {
            declarations: [
              buildNode('VariableDeclaration', {
                name: lhs.name,
                isAccessed: accessed,
                isSecret: true,
              }),
            ],
            modifiesSecretState: true,
          });
          node._newASTPointer = newNode;
          parent._newASTPointer.push(newNode);

          return;
        }
        // if its an incrementation, we need to know it happens but not copy it over
        if (node.expression.isIncremented && indicator.isPartitioned) {
          const newNode = buildNode(node.nodeType, {
            nodeType: node.nodeType,
            expression: {},
            incrementsSecretState: node.expression.isIncremented,
            decrementsSecretState: node.expression.isDecremented,
            privateStateName: indicator.name,
          });

          node._newASTPointer = newNode;
          parent._newASTPointer.push(newNode);
          // state.skipSubNodes = true;
          return;
        }
      }
      if (node.expression.nodeType !== 'FunctionCall') {
        const newNode = buildNode(node.nodeType);
        node._newASTPointer = newNode;
        parent._newASTPointer.push(newNode);
      }
    },

    exit(path) {
      const { node, scope } = path;
      const { leftHandSide: lhs } = node.expression;
      if (path.node._newASTPointer?.incrementsSecretState) {
        const indicator = scope.getReferencedIndicator(lhs, true);
        let increments = '';
        indicator.increments.forEach(inc => {
          increments += inc.name ? `+ ${inc.name} ` : `+ ${inc.value} `;
        });
        indicator.decrements.forEach(dec => {
          increments += dec.name ? `- ${dec.name} ` : `- ${dec.value} `;
        });
        path.node._newASTPointer.increments = increments;
      }
    },
  },

  VariableDeclaration: {
    enter(path, state) {
      const { node, parent, scope } = path;
      if (node.stateVariable) {
        // then the node represents assignment of a state variable - we've handled it.
        node._newASTPointer = parent._newASTPointer;
        state.skipSubNodes = true;
        return;
      }
      // we have a param or a local var dec
      // TODO just use interactsWithSecret when thats added
      let modifiesSecretState = false;

      scope.bindings[node.id].referencingPaths.forEach(refPath => {
        if (scope.getReferencedBinding(refPath.node).isSecret)
          modifiesSecretState = true;
      });

      if (
        parent.nodeType === 'VariableDeclarationStatement' &&
        modifiesSecretState
      )
        parent._newASTPointer.modifiesSecretState = modifiesSecretState;

      // if it's not declaration of a state variable, it's (probably) declaration of a new function parameter. We _do_ want to add this to the newAST.
      const newNode = buildNode(node.nodeType, {
        name: node.name,
        isSecret: node.isSecret,
        modifiesSecretState,
        typeName: {},
      });
      node._newASTPointer = newNode;
      if (Array.isArray(parent._newASTPointer)) {
        parent._newASTPointer.push(newNode);
      } else {
        parent._newASTPointer[path.containerName].push(newNode);
      }
    },

    exit(path) {},
  },

  ElementaryTypeName: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType, { name: node.name });

      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  Identifier: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType, { name: node.name });

      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  IndexAccess: {
    enter(path, state) {
      const { node, parent, scope } = path;
      const indicator = scope.getReferencedIndicator(node, true);
      const newNode = buildNode(node.nodeType, { name: indicator.name });
      state.skipSubNodes = true; // the subnodes are baseExpression and indexExpression - we skip them

      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  MemberAccess: {
    enter(path, state) {
      const { node, parent, scope } = path;
      const indicator = scope.getReferencedIndicator(node, true);
      const newNode = buildNode(node.nodeType, { name: indicator.name });
      state.skipSubNodes = true; // the subnodes are baseExpression and indexExpression - we skip them

      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  Literal: {
    enter(path) {
      const { node, parent } = path;
      const newNode = buildNode(node.nodeType, { value: node.value });

      parent._newASTPointer[path.containerName] = newNode;
    },

    exit(path) {},
  },

  FunctionCall: {
    enter(path, state) {
      // HACK: Not sure how to deal with FunctionCalls for Orchestration, so skipping them
      state.skipSubNodes = true;
    },
  },
};
