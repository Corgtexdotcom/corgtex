"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  Edge,
  Node,
} from "@xyflow/react";
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import CircleNode from "./CircleNode";
import CircleDetailPanel from "./CircleDetailPanel";
import "./circle-graph.css";

const nodeTypes = {
  circleNode: CircleNode,
};

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 260;
const nodeHeight = 100;

function getLayoutedElements(nodes: Node[], edges: Edge[], direction = 'TB') {
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const newNode = { ...node };

    // Dagre returns center coordinates, we need to adapt to top-left
    newNode.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };

    return newNode;
  });

  return { nodes: newNodes, edges };
}

export default function CircleGraph({ treeData, isDemo }: { treeData: any[]; isDemo: boolean }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);

  // Flatten the tree to a single array of items with parent associations
  const flattenTree = useCallback((nodes: any[]): any[] => {
    let result: any[] = [];
    nodes.forEach(node => {
      result.push(node);
      if (node.childCircles && node.childCircles.length > 0) {
        result = result.concat(flattenTree(node.childCircles));
      }
    });
    return result;
  }, []);

  useEffect(() => {
    const flatData = flattenTree(treeData);
    
    const initialNodes: Node[] = flatData.map((item) => ({
      id: item.id,
      type: "circleNode",
      position: { x: 0, y: 0 },
      data: {
        circleId: item.id,
        name: item.name,
        purposeMd: item.purposeMd,
        maturityStage: item.maturityStage,
        roleCount: item.roles?.length || 0,
      },
    }));

    const initialEdges: Edge[] = flatData
      .filter((item) => item.parentCircleId)
      .map((item) => ({
        id: `e-${item.parentCircleId}-${item.id}`,
        source: item.parentCircleId,
        target: item.id,
        type: "smoothstep",
        animated: true,
        style: { stroke: 'var(--muted)', strokeWidth: 2 },
      }));

    if (initialNodes.length > 0) {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
        initialNodes,
        initialEdges,
        'TB'
      );
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    } else {
      setNodes([]);
      setEdges([]);
    }
  }, [treeData, flattenTree, setNodes, setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setNodes((nds) => 
      nds.map((n) => ({
        ...n,
        selected: n.id === node.id
      }))
    );
    setSelectedCircleId(node.data.circleId as string);
  }, [setNodes]);

  const handleClosePanel = () => {
    setSelectedCircleId(null);
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
  };

  return (
    <div style={{ width: "100%", height: "70vh", minHeight: 600, border: "1px solid var(--line)", borderRadius: "var(--radius-lg)", overflow: "hidden", position: "relative", background: "var(--bg)" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={2}
        attributionPosition="bottom-right"
      >
        <Controls />
        <Background gap={24} size={1} color="var(--line)" />
      </ReactFlow>
      
      <CircleDetailPanel 
        open={!!selectedCircleId} 
        circleId={selectedCircleId} 
        treeData={treeData} 
        onClose={handleClosePanel}
        isDemo={isDemo}
      />
    </div>
  );
}
